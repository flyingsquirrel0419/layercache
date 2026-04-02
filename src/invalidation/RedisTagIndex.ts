import type Redis from 'ioredis'
import type { CacheTagIndex } from '../types'
import { PatternMatcher } from './PatternMatcher'

interface RedisTagIndexOptions {
  client: Redis
  prefix?: string
  scanCount?: number
}

export class RedisTagIndex implements CacheTagIndex {
  private readonly client: Redis
  private readonly prefix: string
  private readonly scanCount: number

  constructor(options: RedisTagIndexOptions) {
    this.client = options.client
    this.prefix = options.prefix ?? 'cache-bridge:tag-index'
    this.scanCount = options.scanCount ?? 100
  }

  async touch(key: string): Promise<void> {
    await this.client.sadd(this.knownKeysKey(), key)
  }

  async track(key: string, tags: string[]): Promise<void> {
    const keyTagsKey = this.keyTagsKey(key)
    const existingTags = await this.client.smembers(keyTagsKey)
    const pipeline = this.client.pipeline()

    pipeline.sadd(this.knownKeysKey(), key)

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

    pipeline.srem(this.knownKeysKey(), key)
    pipeline.del(keyTagsKey)

    for (const tag of existingTags) {
      pipeline.srem(this.tagKeysKey(tag), key)
    }

    await pipeline.exec()
  }

  async keysForTag(tag: string): Promise<string[]> {
    return this.client.smembers(this.tagKeysKey(tag))
  }

  async matchPattern(pattern: string): Promise<string[]> {
    const matches: string[] = []
    let cursor = '0'

    do {
      const [nextCursor, keys] = await this.client.sscan(
        this.knownKeysKey(),
        cursor,
        'MATCH',
        pattern,
        'COUNT',
        this.scanCount
      )
      cursor = nextCursor
      matches.push(...keys.filter((key) => PatternMatcher.matches(pattern, key)))
    } while (cursor !== '0')

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

  private knownKeysKey(): string {
    return `${this.prefix}:keys`
  }

  private keyTagsKey(key: string): string {
    return `${this.prefix}:key:${encodeURIComponent(key)}`
  }

  private tagKeysKey(tag: string): string {
    return `${this.prefix}:tag:${encodeURIComponent(tag)}`
  }
}
