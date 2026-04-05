import { unwrapStoredValue } from '../internal/StoredValue'
import { JsonSerializer } from '../serialization/JsonSerializer'
import type { CacheLayer, CacheSerializer } from '../types'

/**
 * Minimal interface that MemcachedLayer expects from a Memcached client.
 * Compatible with the `memjs` and `memcache-client` npm packages.
 *
 * Install one of:
 *   npm install memjs
 *   npm install memcache-client
 */
export interface MemcachedClient {
  get(key: string): Promise<{ value: Buffer | null } | null>
  set(key: string, value: string | Buffer, options?: { expires?: number }): Promise<boolean | undefined>
  delete(key: string): Promise<boolean | undefined>
}

interface MemcachedLayerOptions {
  client: MemcachedClient
  ttl?: number
  name?: string
  keyPrefix?: string
  serializer?: CacheSerializer
}

/**
 * Memcached-backed cache layer.
 *
 * Now supports pluggable serializers (default: JSON), StoredValueEnvelope
 * for stale-while-revalidate / stale-if-error semantics, and bulk reads.
 *
 * Example usage with `memjs`:
 * ```ts
 * import Memjs from 'memjs'
 * import { CacheStack, MemcachedLayer, MemoryLayer } from 'layercache'
 *
 * const memcached = Memjs.Client.create('localhost:11211')
 * const cache = new CacheStack([
 *   new MemoryLayer({ ttl: 30 }),
 *   new MemcachedLayer({ client: memcached, ttl: 300 })
 * ])
 * ```
 */
export class MemcachedLayer implements CacheLayer {
  readonly name: string
  readonly defaultTtl?: number
  readonly isLocal = false

  private readonly client: MemcachedClient
  private readonly keyPrefix: string
  private readonly serializer: CacheSerializer

  constructor(options: MemcachedLayerOptions) {
    this.client = options.client
    this.defaultTtl = options.ttl
    this.name = options.name ?? 'memcached'
    this.keyPrefix = options.keyPrefix ?? ''
    this.serializer = options.serializer ?? new JsonSerializer()
  }

  async get<T>(key: string): Promise<T | null> {
    return unwrapStoredValue<T>(await this.getEntry<T>(key))
  }

  async getEntry<T = unknown>(key: string): Promise<T | null> {
    const result = await this.client.get(this.withPrefix(key))
    if (!result || result.value === null) {
      return null
    }

    try {
      return this.serializer.deserialize<T>(result.value)
    } catch {
      return null
    }
  }

  async getMany<T>(keys: string[]): Promise<Array<T | null>> {
    return Promise.all(keys.map((key) => this.getEntry<T>(key)))
  }

  async set(key: string, value: unknown, ttl = this.defaultTtl): Promise<void> {
    const payload = this.serializer.serialize(value)
    await this.client.set(this.withPrefix(key), payload as string | Buffer, {
      expires: ttl && ttl > 0 ? ttl : undefined
    })
  }

  async has(key: string): Promise<boolean> {
    const result = await this.client.get(this.withPrefix(key))
    return result !== null && result.value !== null
  }

  async delete(key: string): Promise<void> {
    await this.client.delete(this.withPrefix(key))
  }

  async deleteMany(keys: string[]): Promise<void> {
    await Promise.all(keys.map((key) => this.delete(key)))
  }

  async clear(): Promise<void> {
    // Memcached does not support pattern-based deletion.
    // Callers should use a key prefix and rotate it as a workaround.
    throw new Error(
      'MemcachedLayer.clear() is not supported. Use a key prefix and rotate it to effectively invalidate all keys.'
    )
  }

  private withPrefix(key: string): string {
    return `${this.keyPrefix}${key}`
  }
}
