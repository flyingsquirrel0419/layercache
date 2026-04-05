import { brotliCompressSync, brotliDecompressSync, gunzipSync, gzipSync } from 'node:zlib'
import type Redis from 'ioredis'
import { unwrapStoredValue } from '../internal/StoredValue'
import { JsonSerializer } from '../serialization/JsonSerializer'
import type { CacheLayer, CacheSerializer } from '../types'

type CompressionAlgorithm = 'gzip' | 'brotli'

const BATCH_DELETE_SIZE = 500

interface RedisLayerOptions {
  client: Redis
  ttl?: number
  name?: string
  serializer?: CacheSerializer
  prefix?: string
  allowUnprefixedClear?: boolean
  scanCount?: number
  compression?: CompressionAlgorithm
  compressionThreshold?: number
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
  private readonly compression?: CompressionAlgorithm
  private readonly compressionThreshold: number

  constructor(options: RedisLayerOptions) {
    this.client = options.client
    this.defaultTtl = options.ttl
    this.name = options.name ?? 'redis'
    this.serializer = options.serializer ?? new JsonSerializer()
    this.prefix = options.prefix ?? ''
    this.allowUnprefixedClear = options.allowUnprefixedClear ?? false
    this.scanCount = options.scanCount ?? 100
    this.compression = options.compression
    this.compressionThreshold = options.compressionThreshold ?? 1_024
  }

  async get<T>(key: string): Promise<T | null> {
    const payload = await this.getEntry(key)
    return unwrapStoredValue<T>(payload)
  }

  async getEntry<T = unknown>(key: string): Promise<T | null> {
    const payload = await this.client.getBuffer(this.withPrefix(key))
    if (payload === null) {
      return null
    }

    return this.deserializeOrDelete(key, payload)
  }

  async getMany<T>(keys: string[]): Promise<Array<T | null>> {
    if (keys.length === 0) {
      return []
    }

    const pipeline = this.client.pipeline()
    for (const key of keys) {
      pipeline.getBuffer(this.withPrefix(key))
    }

    const results = await pipeline.exec()
    if (results === null) {
      return keys.map(() => null)
    }

    return Promise.all(
      results.map(async (result, index) => {
        const [error, payload] = result
        if (error || payload === null || !this.isSerializablePayload(payload)) {
          return null
        }

        return this.deserializeOrDelete<T>(keys[index] ?? '', payload)
      })
    )
  }

  async set(key: string, value: unknown, ttl = this.defaultTtl): Promise<void> {
    const payload = this.encodePayload(this.serializer.serialize(value))
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

  async has(key: string): Promise<boolean> {
    const exists = await this.client.exists(this.withPrefix(key))
    return exists > 0
  }

  async ttl(key: string): Promise<number | null> {
    const remaining = await this.client.ttl(this.withPrefix(key))
    // -2 = key does not exist, -1 = key exists but no TTL
    if (remaining < 0) {
      return null
    }
    return remaining
  }

  async size(): Promise<number> {
    const keys = await this.keys()
    return keys.length
  }

  /**
   * Deletes all keys matching the layer's prefix in batches to avoid
   * loading millions of keys into memory at once.
   */
  async clear(): Promise<void> {
    if (!this.prefix && !this.allowUnprefixedClear) {
      throw new Error(
        'RedisLayer.clear() requires a prefix or allowUnprefixedClear=true to avoid deleting unrelated keys.'
      )
    }

    const pattern = `${this.prefix}*`
    let cursor = '0'

    do {
      const [nextCursor, keys] = await this.client.scan(cursor, 'MATCH', pattern, 'COUNT', this.scanCount)
      cursor = nextCursor

      if (keys.length === 0) {
        continue
      }

      // Delete in batches to avoid blocking Redis with huge DEL commands
      for (let i = 0; i < keys.length; i += BATCH_DELETE_SIZE) {
        const batch = keys.slice(i, i + BATCH_DELETE_SIZE)
        await this.client.del(...batch)
      }
    } while (cursor !== '0')
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

  private async deserializeOrDelete<T>(key: string, payload: string | Buffer): Promise<T | null> {
    try {
      return this.serializer.deserialize<T>(this.decodePayload(payload))
    } catch {
      await this.client.del(this.withPrefix(key)).catch(() => undefined)
      return null
    }
  }

  private isSerializablePayload(payload: unknown): payload is string | Buffer {
    return typeof payload === 'string' || Buffer.isBuffer(payload)
  }

  private encodePayload(payload: string | Buffer): string | Buffer {
    if (!this.compression) {
      return payload
    }

    const source = Buffer.isBuffer(payload) ? payload : Buffer.from(payload)
    if (source.byteLength < this.compressionThreshold) {
      return payload
    }

    const header = Buffer.from(`LCZ1:${this.compression}:`)
    const compressed = this.compression === 'gzip' ? gzipSync(source) : brotliCompressSync(source)

    return Buffer.concat([header, compressed])
  }

  private decodePayload(payload: string | Buffer): string | Buffer {
    if (!Buffer.isBuffer(payload)) {
      return payload
    }

    if (payload.subarray(0, 10).toString() === 'LCZ1:gzip:') {
      return gunzipSync(payload.subarray(10))
    }

    if (payload.subarray(0, 12).toString() === 'LCZ1:brotli:') {
      return brotliDecompressSync(payload.subarray(12))
    }

    return payload
  }
}
