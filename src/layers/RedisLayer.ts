import type Redis from 'ioredis'
import { JsonSerializer } from '../serialization/JsonSerializer'
import type { CacheLayer, CacheSerializer } from '../types'

interface RedisLayerOptions {
  client: Redis
  ttl?: number
  name?: string
  serializer?: CacheSerializer
  prefix?: string
  allowUnprefixedClear?: boolean
  scanCount?: number
}

export class RedisLayer implements CacheLayer {
  readonly name: string
  readonly defaultTtl?: number
  readonly isLocal = false

  private readonly client: Redis
  private readonly serializer: CacheSerializer
  private readonly prefix: string
  private readonly allowUnprefixedClear: boolean
  private readonly scanCount: number

  constructor(options: RedisLayerOptions) {
    this.client = options.client
    this.defaultTtl = options.ttl
    this.name = options.name ?? 'redis'
    this.serializer = options.serializer ?? new JsonSerializer()
    this.prefix = options.prefix ?? ''
    this.allowUnprefixedClear = options.allowUnprefixedClear ?? false
    this.scanCount = options.scanCount ?? 100
  }

  async get<T>(key: string): Promise<T | null> {
    const payload = await this.client.getBuffer(this.withPrefix(key))
    if (payload === null) {
      return null
    }
    return this.serializer.deserialize<T>(payload)
  }

  async set(key: string, value: unknown, ttl = this.defaultTtl): Promise<void> {
    const payload = this.serializer.serialize(value)
    const normalizedKey = this.withPrefix(key)

    if (ttl && ttl > 0) {
      await this.client.set(normalizedKey, payload as never, 'EX', ttl)
      return
    }

    await this.client.set(normalizedKey, payload as never)
  }

  async delete(key: string): Promise<void> {
    await this.client.del(this.withPrefix(key))
  }

  async deleteMany(keys: string[]): Promise<void> {
    if (keys.length === 0) {
      return
    }
    await this.client.del(...keys.map((key) => this.withPrefix(key)))
  }

  async clear(): Promise<void> {
    if (!this.prefix && !this.allowUnprefixedClear) {
      throw new Error('RedisLayer.clear() requires a prefix or allowUnprefixedClear=true to avoid deleting unrelated keys.')
    }

    const keys = await this.keys()
    if (keys.length > 0) {
      await this.deleteMany(keys)
    }
  }

  async keys(): Promise<string[]> {
    const pattern = `${this.prefix}*`
    const keys = await this.scanKeys(pattern)
    if (!this.prefix) {
      return keys
    }
    return keys.map((key) => key.slice(this.prefix.length))
  }

  private async scanKeys(pattern: string): Promise<string[]> {
    const matches: string[] = []
    let cursor = '0'

    do {
      const [nextCursor, keys] = await this.client.scan(cursor, 'MATCH', pattern, 'COUNT', this.scanCount)
      cursor = nextCursor
      matches.push(...keys)
    } while (cursor !== '0')

    return matches
  }

  private withPrefix(key: string): string {
    return `${this.prefix}${key}`
  }
}
