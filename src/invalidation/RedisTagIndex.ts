import type Redis from 'ioredis'
import type { CacheTagIndex } from '../types'
import { PatternMatcher } from './PatternMatcher'

interface RedisTagIndexOptions {
  client: Redis
  prefix?: string
  scanCount?: number
  knownKeysShards?: number
}

export class RedisTagIndex implements CacheTagIndex {
  private readonly client: Redis
  private readonly prefix: string
  private readonly scanCount: number
  private readonly knownKeysShards: number

  constructor(options: RedisTagIndexOptions) {
    this.client = options.client
    this.prefix = options.prefix ?? 'layercache:tag-index'
    this.scanCount = options.scanCount ?? 100
    this.knownKeysShards = normalizeKnownKeysShards(options.knownKeysShards)
  }

  async touch(key: string): Promise<void> {
    await this.client.sadd(this.knownKeysKeyFor(key), key)
  }

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

  async remove(key: string): Promise<void> {
    const keyTagsKey = this.keyTagsKey(key)
    const existingTags = await this.client.smembers(keyTagsKey)
    const pipeline = this.client.pipeline()

    pipeline.srem(this.knownKeysKeyFor(key), key)
    pipeline.del(keyTagsKey)

    for (const tag of existingTags) {
      pipeline.srem(this.tagKeysKey(tag), key)
    }

    await pipeline.exec()
  }

  async keysForTag(tag: string): Promise<string[]> {
    return this.client.smembers(this.tagKeysKey(tag))
  }

  async keysForPrefix(prefix: string): Promise<string[]> {
    const matches: string[] = []
    for (const knownKeysKey of this.knownKeysKeys()) {
      let cursor = '0'

      do {
        const [nextCursor, keys] = await this.client.sscan(knownKeysKey, cursor, 'COUNT', this.scanCount)
        cursor = nextCursor
        matches.push(...keys.filter((key) => key.startsWith(prefix)))
      } while (cursor !== '0')
    }

    return matches
  }

  async tagsForKey(key: string): Promise<string[]> {
    return this.client.smembers(this.keyTagsKey(key))
  }

  async matchPattern(pattern: string): Promise<string[]> {
    const matches: string[] = []
    for (const knownKeysKey of this.knownKeysKeys()) {
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
        matches.push(...keys.filter((key) => PatternMatcher.matches(pattern, key)))
      } while (cursor !== '0')
    }

    return matches
  }

  async clear(): Promise<void> {
    const indexKeys = await this.scanIndexKeys()
    if (indexKeys.length === 0) {
      return
    }

    await this.client.del(...indexKeys)
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

  private knownKeysKeys(): string[] {
    if (this.knownKeysShards === 1) {
      return [`${this.prefix}:keys`]
    }

    return Array.from({ length: this.knownKeysShards }, (_, index) => `${this.prefix}:keys:${index}`)
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
    return 1
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
