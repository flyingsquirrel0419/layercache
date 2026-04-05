import type { CacheStack } from './CacheStack'
import type {
  CacheGetOptions,
  CacheHitRateSnapshot,
  CacheMGetEntry,
  CacheMSetEntry,
  CacheMetricsSnapshot,
  CacheWarmEntry,
  CacheWarmOptions,
  CacheWrapOptions,
  CacheWriteOptions
} from './types'

export class CacheNamespace {
  constructor(
    private readonly cache: CacheStack,
    private readonly prefix: string
  ) {}

  async get<T>(key: string, fetcher?: () => Promise<T>, options?: CacheGetOptions): Promise<T | null> {
    return this.cache.get(this.qualify(key), fetcher, options)
  }

  async getOrSet<T>(key: string, fetcher: () => Promise<T>, options?: CacheGetOptions): Promise<T | null> {
    return this.cache.getOrSet(this.qualify(key), fetcher, options)
  }

  async has(key: string): Promise<boolean> {
    return this.cache.has(this.qualify(key))
  }

  async ttl(key: string): Promise<number | null> {
    return this.cache.ttl(this.qualify(key))
  }

  async set<T>(key: string, value: T, options?: CacheWriteOptions): Promise<void> {
    await this.cache.set(this.qualify(key), value, options)
  }

  async delete(key: string): Promise<void> {
    await this.cache.delete(this.qualify(key))
  }

  async mdelete(keys: string[]): Promise<void> {
    await this.cache.mdelete(keys.map((k) => this.qualify(k)))
  }

  async clear(): Promise<void> {
    await this.cache.invalidateByPattern(`${this.prefix}:*`)
  }

  async mget<T>(entries: CacheMGetEntry<T>[]): Promise<Array<T | null>> {
    return this.cache.mget(
      entries.map((entry) => ({
        ...entry,
        key: this.qualify(entry.key)
      }))
    )
  }

  async mset<T>(entries: CacheMSetEntry<T>[]): Promise<void> {
    await this.cache.mset(
      entries.map((entry) => ({
        ...entry,
        key: this.qualify(entry.key)
      }))
    )
  }

  async invalidateByTag(tag: string): Promise<void> {
    await this.cache.invalidateByTag(tag)
  }

  async invalidateByPattern(pattern: string): Promise<void> {
    await this.cache.invalidateByPattern(this.qualify(pattern))
  }

  wrap<TArgs extends unknown[], TResult>(
    keyPrefix: string,
    fetcher: (...args: TArgs) => Promise<TResult>,
    options?: CacheWrapOptions<TArgs>
  ): (...args: TArgs) => Promise<TResult | null> {
    return this.cache.wrap(`${this.prefix}:${keyPrefix}`, fetcher, options)
  }

  warm(entries: CacheWarmEntry[], options?: CacheWarmOptions): Promise<void> {
    return this.cache.warm(
      entries.map((entry) => ({
        ...entry,
        key: this.qualify(entry.key)
      })),
      options
    )
  }

  getMetrics(): CacheMetricsSnapshot {
    return this.cache.getMetrics()
  }

  getHitRate(): CacheHitRateSnapshot {
    return this.cache.getHitRate()
  }

  qualify(key: string): string {
    return `${this.prefix}:${key}`
  }
}
