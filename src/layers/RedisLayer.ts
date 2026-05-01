import { Readable, type Transform } from 'node:stream'
import { promisify } from 'node:util'
import { brotliCompress, createBrotliDecompress, createGunzip, gzip } from 'node:zlib'
import type Redis from 'ioredis'
import { unwrapStoredValue } from '../internal/StoredValue'
import { JsonSerializer } from '../serialization/JsonSerializer'
import type { CacheLayer, CacheLayerSetManyEntry, CacheSerializer } from '../types'

type CompressionAlgorithm = 'gzip' | 'brotli'

const BATCH_DELETE_SIZE = 500

const gzipAsync = promisify(gzip)
const brotliCompressAsync = promisify(brotliCompress)

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
  /**
   * Per-command timeout in milliseconds for Redis round-trips.
   * Slow commands reject so CacheStack can treat the layer as degraded.
   */
  commandTimeoutMs?: number
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
  private readonly commandTimeoutMs: number | undefined
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
    this.commandTimeoutMs = this.normalizeCommandTimeoutMs(options.commandTimeoutMs)
    this.disconnectOnDispose = options.disconnectOnDispose ?? false
  }

  async get<T>(key: string): Promise<T | null> {
    const payload = await this.getEntry(key)
    return unwrapStoredValue<T>(payload)
  }

  async getEntry<T = unknown>(key: string): Promise<T | null> {
    this.validateKey(key)
    const payload = await this.runCommand(`get(${this.displayKey(key)})`, () =>
      this.client.getBuffer(this.withPrefix(key))
    )
    if (payload === null) {
      return null
    }

    return this.deserializeOrDelete(key, payload)
  }

  async getMany<T>(keys: string[]): Promise<Array<T | null>> {
    if (keys.length === 0) {
      return []
    }

    for (const key of keys) {
      this.validateKey(key)
    }

    const pipeline = this.client.pipeline()
    for (const key of keys) {
      pipeline.getBuffer(this.withPrefix(key))
    }

    const results = await this.runCommand(`mget(${keys.length})`, () => pipeline.exec())
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

    for (const entry of entries) {
      this.validateKey(entry.key)
    }

    const pipeline = this.client.pipeline()
    for (const entry of entries) {
      const serialized = this.primarySerializer().serialize(entry.value)
      const payload = await this.encodePayload(serialized)
      const normalizedKey = this.withPrefix(entry.key)
      if (entry.ttl && entry.ttl > 0) {
        pipeline.set(normalizedKey, payload as never, 'PX', entry.ttl)
      } else {
        pipeline.set(normalizedKey, payload as never)
      }
    }

    await this.runCommand(`mset(${entries.length})`, () => pipeline.exec())
  }

  async set(key: string, value: unknown, ttl = this.defaultTtl): Promise<void> {
    this.validateKey(key)
    const serialized = this.primarySerializer().serialize(value)
    const payload = await this.encodePayload(serialized)
    const normalizedKey = this.withPrefix(key)

    if (ttl && ttl > 0) {
      await this.runCommand(`set(${this.displayKey(key)})`, () =>
        this.client.set(normalizedKey, payload as never, 'PX', ttl)
      )
      return
    }

    await this.runCommand(`set(${this.displayKey(key)})`, () => this.client.set(normalizedKey, payload as never))
  }

  async delete(key: string): Promise<void> {
    this.validateKey(key)
    await this.runCommand(`delete(${this.displayKey(key)})`, () => this.client.del(this.withPrefix(key)))
  }

  async deleteMany(keys: string[]): Promise<void> {
    if (keys.length === 0) {
      return
    }
    for (const key of keys) {
      this.validateKey(key)
    }
    await this.runCommand(`deleteMany(${keys.length})`, () =>
      this.client.del(...keys.map((key) => this.withPrefix(key)))
    )
  }

  async has(key: string): Promise<boolean> {
    this.validateKey(key)
    const exists = await this.runCommand(`has(${this.displayKey(key)})`, () => this.client.exists(this.withPrefix(key)))
    return exists > 0
  }

  async ttl(key: string): Promise<number | null> {
    this.validateKey(key)
    const remaining = await this.runCommand(`ttl(${this.displayKey(key)})`, () =>
      this.client.pttl(this.withPrefix(key))
    )
    // -2 = key does not exist, -1 = key exists but no TTL
    if (remaining < 0) {
      return null
    }
    return remaining
  }

  async size(): Promise<number> {
    if (!this.prefix) {
      return this.runCommand('dbsize()', () => this.client.dbsize())
    }

    const pattern = `${this.prefix}*`
    let cursor = '0'
    let count = 0

    do {
      const [nextCursor, keys] = await this.runCommand(`scan("${pattern}")`, () =>
        this.client.scan(cursor, 'MATCH', pattern, 'COUNT', this.scanCount)
      )
      cursor = nextCursor
      count += keys.length
    } while (cursor !== '0')

    return count
  }

  async ping(): Promise<boolean> {
    try {
      return (await this.runCommand('ping()', () => this.client.ping())) === 'PONG'
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
      const [nextCursor, keys] = await this.runCommand(`scan("${pattern}")`, () =>
        this.client.scan(cursor, 'MATCH', pattern, 'COUNT', this.scanCount)
      )
      cursor = nextCursor

      if (keys.length === 0) {
        continue
      }

      // Delete in batches to avoid blocking Redis with huge DEL commands
      for (let i = 0; i < keys.length; i += BATCH_DELETE_SIZE) {
        const batch = keys.slice(i, i + BATCH_DELETE_SIZE)
        await this.runCommand(`clear-del(${batch.length})`, () => this.client.del(...batch))
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

  async forEachKey(visitor: (key: string) => void | Promise<void>): Promise<void> {
    const pattern = `${this.prefix}*`
    let cursor = '0'

    do {
      const [nextCursor, keys] = await this.runCommand(`scan("${pattern}")`, () =>
        this.client.scan(cursor, 'MATCH', pattern, 'COUNT', this.scanCount)
      )
      cursor = nextCursor

      for (const key of keys) {
        await visitor(this.prefix ? key.slice(this.prefix.length) : key)
      }
    } while (cursor !== '0')
  }

  private async scanKeys(pattern: string): Promise<string[]> {
    const matches: string[] = []
    let cursor = '0'

    do {
      const [nextCursor, keys] = await this.runCommand(`scan("${pattern}")`, () =>
        this.client.scan(cursor, 'MATCH', pattern, 'COUNT', this.scanCount)
      )
      cursor = nextCursor
      matches.push(...keys)
    } while (cursor !== '0')

    return matches
  }

  private withPrefix(key: string): string {
    return `${this.prefix}${key}`
  }

  private validateKey(key: string): void {
    if (key.length === 0) {
      throw new Error('RedisLayer: key must not be empty.')
    }

    if (key.length > 1_024) {
      throw new Error(`RedisLayer: key length must be at most 1 024 characters (got ${key.length}).`)
    }

    if (/[\u0000-\u001F\u007F]/.test(key)) {
      throw new Error('RedisLayer: key contains unsupported control characters.')
    }

    if (/[\uD800-\uDFFF]/.test(key)) {
      throw new Error('RedisLayer: key contains unsupported surrogate code points.')
    }
  }

  private displayKey(key: string): string {
    return key.length > 64 ? `${key.slice(0, 64)}...` : key
  }

  private async deserializeOrDelete<T>(key: string, payload: string | Buffer): Promise<T | null> {
    let decodedPayload: string | Buffer
    try {
      decodedPayload = await this.decodePayload(payload)
    } catch {
      await this.deleteCorruptedKey(key)
      return null
    }

    for (const serializer of this.serializers) {
      try {
        const value = serializer.deserialize<T>(decodedPayload)
        if (serializer !== this.primarySerializer()) {
          /* v8 ignore next -- rewrite failures are intentionally non-fatal during legacy reads */
          await this.rewriteWithPrimarySerializer(key, value).catch(() => undefined)
        }
        return value
      } catch {
        // try next serializer
      }
    }

    await this.deleteCorruptedKey(key)
    return null
  }

  private async deleteCorruptedKey(key: string): Promise<void> {
    try {
      await this.runCommand(`deleteCorrupted(${this.displayKey(key)})`, () => this.client.del(this.withPrefix(key)))
    } catch (deleteError) {
      // Log but don't throw — the original deserialization failure is the primary issue.
      // The corrupted key will be retried on next access.
      const displayKey = key.length > 64 ? `${key.slice(0, 64)}...` : key
      console.warn(`[layercache] RedisLayer: failed to delete corrupted key "${displayKey}"`, deleteError)
    }
  }

  private async rewriteWithPrimarySerializer(key: string, value: unknown): Promise<void> {
    const serialized = this.primarySerializer().serialize(value)
    const payload = await this.encodePayload(serialized)
    const ttl = await this.runCommand(`rewrite-ttl(${this.displayKey(key)})`, () =>
      this.client.pttl(this.withPrefix(key))
    )
    if (ttl > 0) {
      await this.runCommand(`rewrite-set(${this.displayKey(key)})`, () =>
        this.client.set(this.withPrefix(key), payload as never, 'PX', ttl)
      )
      return
    }

    await this.runCommand(`rewrite-set(${this.displayKey(key)})`, () =>
      this.client.set(this.withPrefix(key), payload as never)
    )
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
      return this.decompressWithLimit(createGunzip(), payload.subarray(10))
    }

    if (payload.subarray(0, 12).toString() === 'LCZ1:brotli:') {
      return this.decompressWithLimit(createBrotliDecompress(), payload.subarray(12))
    }

    return payload
  }

  private async decompressWithLimit(decompressor: Transform, payload: Buffer): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      const source = Readable.from(payload)
      const chunks: Buffer[] = []
      let totalBytes = 0
      let settled = false

      const cleanup = (): void => {
        decompressor.removeAllListeners()
      }

      const fail = (error: Error): void => {
        /* v8 ignore next -- data is not emitted after this helper settles in supported streams */
        if (settled) {
          return
        }
        settled = true
        cleanup()
        source.unpipe(decompressor)
        source.destroy()
        decompressor.destroy()
        reject(error)
      }

      decompressor.on('data', (chunk: Buffer | string) => {
        /* v8 ignore next -- zlib streams emit Buffer chunks in normal operation */
        const normalized = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        totalBytes += normalized.byteLength
        if (totalBytes > this.decompressionMaxBytes) {
          fail(
            new Error(
              `Decompressed payload (${totalBytes} bytes) exceeds decompressionMaxBytes limit (${this.decompressionMaxBytes} bytes).`
            )
          )
          return
        }

        chunks.push(normalized)
      })

      decompressor.once('error', (error) => {
        /* v8 ignore next -- error is not emitted after this helper settles in supported streams */
        if (settled) {
          return
        }
        settled = true
        cleanup()
        reject(error)
      })

      decompressor.once('end', () => {
        /* v8 ignore next -- end is not emitted after this helper settles in supported streams */
        if (settled) {
          return
        }
        settled = true
        cleanup()
        resolve(Buffer.concat(chunks))
      })

      source.pipe(decompressor)
    })
  }

  private normalizeCommandTimeoutMs(value: number | undefined): number | undefined {
    if (value === undefined) {
      return undefined
    }

    if (!Number.isFinite(value) || value <= 0) {
      throw new Error('RedisLayer.commandTimeoutMs must be a positive number.')
    }

    return value
  }

  private async runCommand<T>(operation: string, command: () => Promise<T>): Promise<T> {
    const promise = command()
    if (!this.commandTimeoutMs) {
      return promise
    }

    let timer: ReturnType<typeof setTimeout> | undefined

    return Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        /* v8 ignore next -- timeout rejection path is covered by slow-command tests */
        timer = setTimeout(() => {
          reject(new Error(`RedisLayer command ${operation} timed out after ${this.commandTimeoutMs}ms.`))
        }, this.commandTimeoutMs)
        timer.unref?.()
      })
    ]).finally(() => {
      /* v8 ignore next -- timer is assigned synchronously when commandTimeoutMs is set */
      if (timer) {
        clearTimeout(timer)
      }
    })
  }
}
