import type { CacheLayer } from '../types'

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
  set(key: string, value: string | Buffer, options?: { expires?: number }): Promise<boolean | void>
  delete(key: string): Promise<boolean | void>
}

interface MemcachedLayerOptions {
  client: MemcachedClient
  ttl?: number
  name?: string
  keyPrefix?: string
}

/**
 * Memcached-backed cache layer.
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

  constructor(options: MemcachedLayerOptions) {
    this.client = options.client
    this.defaultTtl = options.ttl
    this.name = options.name ?? 'memcached'
    this.keyPrefix = options.keyPrefix ?? ''
  }

  async get<T>(key: string): Promise<T | null> {
    const result = await this.client.get(this.withPrefix(key))
    if (!result || result.value === null) {
      return null
    }

    try {
      return JSON.parse(result.value.toString('utf8')) as T
    } catch {
      return null
    }
  }

  async set(key: string, value: unknown, ttl = this.defaultTtl): Promise<void> {
    const payload = JSON.stringify(value)
    await this.client.set(this.withPrefix(key), payload, {
      expires: ttl && ttl > 0 ? ttl : undefined
    })
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
