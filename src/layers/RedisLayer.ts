import { promisify } from 'node:util'
import { brotliCompress, brotliDecompress, gunzip, gzip } from 'node:zlib'
import type Redis from 'ioredis'
import { unwrapStoredValue } from '../internal/StoredValue'
import { JsonSerializer } from '../serialization/JsonSerializer'
import type { CacheLayer, CacheLayerSetManyEntry, CacheSerializer } from '../types'

type CompressionAlgorithm = 'gzip' | 'brotli'

const BATCH_DELETE_SIZE = 500

const gzipAsync = promisify(gzip)
const gunzipAsync = promisify(gunzip)
const brotliCompressAsync = promisify(brotliCompress)
const brotliDecompressAsync = promisify(brotliDecompress)

interface RedisLayerOptions {
  client: Redis
  ttl?: number
  name?: string
  serializer?: CacheSerializer | CacheSerializer[]
  prefix?: string
  allowUnprefixedClear?: boolean
  scanCount?: number
  compression?: CompressionAlgorithm
  compressionThreshold?: number
  /**
   * Maximum number of bytes allowed after decompression.
   * Prevents decompression bomb attacks. Defaults to 64 MiB.
   */
  decompressionMaxBytes?: number
  disconnectOnDispose?: boolean
}

export class RedisLayer implements CacheLayer {
  readonly name: string
  readonly defaultTtl?: number
  readonly isLocal = false

  private readonly client: Redis
  private readonly serializers: CacheSerializer[]
  private readonly prefix: string
  private readonly allowUnprefixedClear: boolean
  private readonly scanCount: number
  private readonly compression?: CompressionAlgorithm
  private readonly compressionThreshold: number
  private readonly decompressionMaxBytes: number
  private readonly disconnectOnDispose: boolean

  constructor(options: RedisLayerOptions) {
    this.client = options.client
    this.defaultTtl = options.ttl
    this.name = options.name ?? 'redis'
    this.serializers = Array.isArray(options.serializer)
      ? options.serializer
      : [options.serializer ?? new JsonSerializer()]
    this.prefix = options.prefix ?? ''
    this.allowUnprefixedClear = options.allowUnprefixedClear ?? false
    this.scanCount = options.scanCount ?? 100
    this.compression = options.compression
    this.compressionThreshold = options.compressionThreshold ?? 1_024
    this.decompressionMaxBytes = options.decompressionMaxBytes ?? 64 * 1_024 * 1_024
    this.disconnectOnDispose = options.disconnectOnDispose ?? false
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

  async setMany(entries: CacheLayerSetManyEntry[]): Promise<void> {
    if (entries.length === 0) {
      return
    }

    const pipeline = this.client.pipeline()
    for (const entry of entries) {
      const serialized = this.primarySerializer().serialize(entry.value)
      const payload = await this.encodePayload(serialized)
      const normalizedKey = this.withPrefix(entry.key)
      if (entry.ttl && entry.ttl > 0) {
        pipeline.set(normalizedKey, payload as never, 'EX', entry.ttl)
      } else {
        pipeline.set(normalizedKey, payload as never)
      }
    }

    await pipeline.exec()
  }

  async set(key: string, value: unknown, ttl = this.defaultTtl): Promise<void> {
    const serialized = this.primarySerializer().serialize(value)
    const payload = await this.encodePayload(serialized)
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

  async ping(): Promise<boolean> {
    try {
      return (await this.client.ping()) === 'PONG'
    } catch {
      return false
    }
  }

  async dispose(): Promise<void> {
    if (this.disconnectOnDispose) {
      this.client.disconnect()
    }
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
    const decodedPayload = await this.decodePayload(payload)

    for (const serializer of this.serializers) {
      try {
        const value = serializer.deserialize<T>(decodedPayload)
        if (serializer !== this.primarySerializer()) {
          await this.rewriteWithPrimarySerializer(key, value).catch(() => undefined)
        }
        return value
      } catch {
        // try next serializer
      }
    }

    try {
      await this.client.del(this.withPrefix(key))
    } catch (deleteError) {
      // Log but don't throw — the original deserialization failure is the primary issue.
      // The corrupted key will be retried on next access.
      console.warn(`[layercache] RedisLayer: failed to delete corrupted key "${key}"`, deleteError)
    }
    return null
  }

  private async rewriteWithPrimarySerializer(key: string, value: unknown): Promise<void> {
    const serialized = this.primarySerializer().serialize(value)
    const payload = await this.encodePayload(serialized)
    const ttl = await this.client.ttl(this.withPrefix(key))
    if (ttl > 0) {
      await this.client.set(this.withPrefix(key), payload as never, 'EX', ttl)
      return
    }

    await this.client.set(this.withPrefix(key), payload as never)
  }

  private primarySerializer(): CacheSerializer {
    const serializer = this.serializers[0]
    if (!serializer) {
      throw new Error('RedisLayer requires at least one serializer.')
    }
    return serializer
  }

  private isSerializablePayload(payload: unknown): payload is string | Buffer {
    return typeof payload === 'string' || Buffer.isBuffer(payload)
  }

  /**
   * Compresses the payload asynchronously if compression is enabled and the
   * payload exceeds the threshold. This avoids blocking the event loop.
   */
  private async encodePayload(payload: string | Buffer): Promise<string | Buffer> {
    if (!this.compression) {
      return payload
    }

    const source = Buffer.isBuffer(payload) ? payload : Buffer.from(payload)
    if (source.byteLength < this.compressionThreshold) {
      return payload
    }

    const header = Buffer.from(`LCZ1:${this.compression}:`)
    const compressed = this.compression === 'gzip' ? await gzipAsync(source) : await brotliCompressAsync(source)

    return Buffer.concat([header, compressed])
  }

  /**
   * Decompresses the payload asynchronously if a compression header is present.
   * Enforces a maximum decompressed size to prevent decompression bomb attacks.
   */
  private async decodePayload(payload: string | Buffer): Promise<string | Buffer> {
    if (!Buffer.isBuffer(payload)) {
      return payload
    }

    if (payload.subarray(0, 10).toString() === 'LCZ1:gzip:') {
      const decompressed = await gunzipAsync(payload.subarray(10))
      if (decompressed.byteLength > this.decompressionMaxBytes) {
        throw new Error(
          `Decompressed payload (${decompressed.byteLength} bytes) exceeds decompressionMaxBytes limit (${this.decompressionMaxBytes} bytes).`
        )
      }
      return decompressed
    }

    if (payload.subarray(0, 12).toString() === 'LCZ1:brotli:') {
      const decompressed = await brotliDecompressAsync(payload.subarray(12))
      if (decompressed.byteLength > this.decompressionMaxBytes) {
        throw new Error(
          `Decompressed payload (${decompressed.byteLength} bytes) exceeds decompressionMaxBytes limit (${this.decompressionMaxBytes} bytes).`
        )
      }
      return decompressed
    }

    return payload
  }
}
