import type Redis from 'ioredis'
import type { CacheLogger, CacheTagIndex } from '../types'
import { PatternMatcher } from './PatternMatcher'

const DEFAULT_KNOWN_KEYS_SHARDS = 16

interface RedisTagIndexOptions {
  /** Redis client used for tag and known-key sets. */
  client: Redis
  /** Redis key prefix for index data. Defaults to `layercache:tag-index`. */
  prefix?: string
  /** Redis SCAN count hint used by pattern and prefix discovery. Defaults to 100. */
  scanCount?: number
  /** Number of shards for known-key sets. Defaults to 16. */
  knownKeysShards?: number
  /** Optional logger for legacy index warnings. */
  logger?: CacheLogger
}

interface RedisTagIndexMigrationResult {
  migratedKeys: number
}

export class RedisTagIndex implements CacheTagIndex {
  private readonly client: Redis
  private readonly prefix: string
  private readonly scanCount: number
  private readonly knownKeysShards: number
  private readonly logger?: CacheLogger
  private warnedLegacyKnownKeys = false

  constructor(options: RedisTagIndexOptions) {
    this.client = options.client
    this.prefix = options.prefix ?? 'layercache:tag-index'
    this.scanCount = options.scanCount ?? 100
    this.knownKeysShards = normalizeKnownKeysShards(options.knownKeysShards)
    this.logger = options.logger
  }

  /**
   * Records a key as known without changing tag assignments.
   */
  async touch(key: string): Promise<void> {
    await this.client.sadd(this.knownKeysKeyFor(key), key)
  }

  /**
   * Replaces the tags associated with a key and records the key as known.
   */
  async track(key: string, tags: string[]): Promise<void> {
    const keyTagsKey = this.keyTagsKey(key)
    const existingTags = await this.client.smembers(keyTagsKey)
    const pipeline = this.client.pipeline()

    pipeline.sadd(this.knownKeysKeyFor(key), key)

    for (const tag of existingTags) {
      pipeline.srem(this.tagKeysKey(tag), key)
    }

    pipeline.del(keyTagsKey)

    if (tags.length > 0) {
      pipeline.sadd(keyTagsKey, ...tags)
      for (const tag of new Set(tags)) {
        pipeline.sadd(this.tagKeysKey(tag), key)
      }
    }

    await pipeline.exec()
  }

  /**
   * Removes a key from all tag mappings and known-key tracking.
   */
  async remove(key: string): Promise<void> {
    const keyTagsKey = this.keyTagsKey(key)
    const existingTags = await this.client.smembers(keyTagsKey)
    const pipeline = this.client.pipeline()

    pipeline.srem(this.knownKeysKeyFor(key), key)
    if (this.knownKeysShards > 1) {
      pipeline.srem(this.legacyKnownKeysKey(), key)
    }
    pipeline.del(keyTagsKey)

    for (const tag of existingTags) {
      pipeline.srem(this.tagKeysKey(tag), key)
    }

    await pipeline.exec()
  }

  /**
   * Returns keys currently associated with a tag.
   */
  async keysForTag(tag: string): Promise<string[]> {
    return this.client.smembers(this.tagKeysKey(tag))
  }

  /**
   * Visits keys currently associated with a tag.
   */
  async forEachKeyForTag(tag: string, visitor: (key: string) => void | Promise<void>): Promise<void> {
    let cursor = '0'
    const tagKey = this.tagKeysKey(tag)

    do {
      const [nextCursor, keys] = await this.client.sscan(tagKey, cursor, 'COUNT', this.scanCount)
      cursor = nextCursor
      for (const key of keys) {
        await visitor(key)
      }
    } while (cursor !== '0')
  }

  /**
   * Returns known keys that start with a prefix.
   */
  async keysForPrefix(prefix: string): Promise<string[]> {
    const matches = new Set<string>()
    for (const knownKeysKey of await this.knownKeysKeysForRead()) {
      let cursor = '0'

      do {
        const [nextCursor, keys] = await this.client.sscan(knownKeysKey, cursor, 'COUNT', this.scanCount)
        cursor = nextCursor
        for (const key of keys) {
          if (key.startsWith(prefix)) {
            matches.add(key)
          }
        }
      } while (cursor !== '0')
    }

    return [...matches]
  }

  /**
   * Visits known keys that start with a prefix.
   */
  async forEachKeyForPrefix(prefix: string, visitor: (key: string) => void | Promise<void>): Promise<void> {
    const visited = new Set<string>()
    for (const knownKeysKey of await this.knownKeysKeysForRead()) {
      let cursor = '0'

      do {
        const [nextCursor, keys] = await this.client.sscan(knownKeysKey, cursor, 'COUNT', this.scanCount)
        cursor = nextCursor
        for (const key of keys) {
          if (key.startsWith(prefix) && !visited.has(key)) {
            visited.add(key)
            await visitor(key)
          }
        }
      } while (cursor !== '0')
    }
  }

  /**
   * Returns the tags currently associated with a key.
   */
  async tagsForKey(key: string): Promise<string[]> {
    return this.client.smembers(this.keyTagsKey(key))
  }

  /**
   * Returns known keys matching a wildcard pattern.
   */
  async matchPattern(pattern: string): Promise<string[]> {
    const matches = new Set<string>()
    for (const knownKeysKey of await this.knownKeysKeysForRead()) {
      let cursor = '0'

      do {
        const [nextCursor, keys] = await this.client.sscan(
          knownKeysKey,
          cursor,
          'MATCH',
          pattern,
          'COUNT',
          this.scanCount
        )
        cursor = nextCursor
        for (const key of keys) {
          if (PatternMatcher.matches(pattern, key)) {
            matches.add(key)
          }
        }
      } while (cursor !== '0')
    }

    return [...matches]
  }

  /**
   * Visits known keys matching a wildcard pattern.
   */
  async forEachKeyMatchingPattern(pattern: string, visitor: (key: string) => void | Promise<void>): Promise<void> {
    const visited = new Set<string>()
    for (const knownKeysKey of await this.knownKeysKeysForRead()) {
      let cursor = '0'

      do {
        const [nextCursor, keys] = await this.client.sscan(
          knownKeysKey,
          cursor,
          'MATCH',
          pattern,
          'COUNT',
          this.scanCount
        )
        cursor = nextCursor
        for (const key of keys) {
          if (PatternMatcher.matches(pattern, key) && !visited.has(key)) {
            visited.add(key)
            await visitor(key)
          }
        }
      } while (cursor !== '0')
    }
  }

  /**
   * Clears all Redis tag-index state under this prefix.
   */
  async clear(): Promise<void> {
    const indexKeys = await this.scanIndexKeys()
    if (indexKeys.length === 0) {
      return
    }

    await this.client.del(...indexKeys)
  }

  async migrateLegacyKnownKeys(): Promise<RedisTagIndexMigrationResult> {
    if (this.knownKeysShards === 1) {
      return { migratedKeys: 0 }
    }

    const legacyKey = this.legacyKnownKeysKey()
    let cursor = '0'
    let migratedKeys = 0

    do {
      const [nextCursor, keys] = await this.client.sscan(legacyKey, cursor, 'COUNT', this.scanCount)
      cursor = nextCursor
      if (keys.length === 0) {
        continue
      }

      const pipeline = this.client.pipeline()
      for (const key of keys) {
        pipeline.sadd(this.knownKeysKeyFor(key), key)
      }
      await pipeline.exec()
      migratedKeys += keys.length
    } while (cursor !== '0')

    if (migratedKeys > 0) {
      await this.client.del(legacyKey)
    }

    return { migratedKeys }
  }

  private async scanIndexKeys(): Promise<string[]> {
    const matches: string[] = []
    let cursor = '0'
    const pattern = `${this.prefix}:*`

    do {
      const [nextCursor, keys] = await this.client.scan(cursor, 'MATCH', pattern, 'COUNT', this.scanCount)
      cursor = nextCursor
      matches.push(...keys)
    } while (cursor !== '0')

    return matches
  }

  private knownKeysKeyFor(key: string): string {
    if (this.knownKeysShards === 1) {
      return `${this.prefix}:keys`
    }

    return `${this.prefix}:keys:${simpleHash(key) % this.knownKeysShards}`
  }

  private async knownKeysKeysForRead(): Promise<string[]> {
    if (this.knownKeysShards === 1) {
      return [this.legacyKnownKeysKey()]
    }

    const shardedKeys = this.knownKeysKeys()
    const legacyKey = this.legacyKnownKeysKey()
    const legacyExists = (await this.client.exists(legacyKey)) > 0
    if (!legacyExists) {
      return shardedKeys
    }

    this.warnLegacyKnownKeys(legacyKey)
    return [legacyKey, ...shardedKeys]
  }

  private knownKeysKeys(): string[] {
    if (this.knownKeysShards === 1) {
      return [`${this.prefix}:keys`]
    }

    return Array.from({ length: this.knownKeysShards }, (_, index) => `${this.prefix}:keys:${index}`)
  }

  private legacyKnownKeysKey(): string {
    return `${this.prefix}:keys`
  }

  private warnLegacyKnownKeys(legacyKey: string): void {
    if (this.warnedLegacyKnownKeys) {
      return
    }

    this.warnedLegacyKnownKeys = true
    const message =
      'RedisTagIndex detected a legacy RedisTagIndex known-key set. Run `layercache migrate-tag-index` to migrate keys into the sharded layout.'
    if (this.logger?.warn) {
      this.logger.warn(message, { legacyKey, knownKeysShards: this.knownKeysShards })
      return
    }
    console.warn(`[layercache] ${message}`, { legacyKey, knownKeysShards: this.knownKeysShards })
  }

  private keyTagsKey(key: string): string {
    return `${this.prefix}:key:${encodeURIComponent(key)}`
  }

  private tagKeysKey(tag: string): string {
    return `${this.prefix}:tag:${encodeURIComponent(tag)}`
  }
}

function normalizeKnownKeysShards(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_KNOWN_KEYS_SHARDS
  }

  if (!Number.isInteger(value) || value <= 0) {
    throw new Error('RedisTagIndex.knownKeysShards must be a positive integer.')
  }

  return value
}

function simpleHash(value: string): number {
  let hash = 0
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0
  }
  return hash
}
