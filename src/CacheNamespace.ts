import type {
  CacheGetOptions,
  CacheMGetEntry,
  CacheMSetEntry,
  CacheMetricsSnapshot,
  CacheWarmEntry,
  CacheWarmOptions,
  CacheWrapOptions,
  CacheWriteOptions
} from './types'
import type { CacheStack } from './CacheStack'

export class CacheNamespace {
  constructor(
    private readonly cache: CacheStack,
    private readonly prefix: string
  ) {}

  async get<T>(key: string, fetcher?: () => Promise<T>, options?: CacheGetOptions): Promise<T | null> {
    return this.cache.get(this.qualify(key), fetcher, options)
  }

  async set<T>(key: string, value: T, options?: CacheWriteOptions): Promise<void> {
    await this.cache.set(this.qualify(key), value, options)
  }

  async delete(key: string): Promise<void> {
    await this.cache.delete(this.qualify(key))
  }

  async clear(): Promise<void> {
    await this.cache.invalidateByPattern(`${this.prefix}:*`)
  }

  async mget<T>(entries: CacheMGetEntry<T>[]): Promise<Array<T | null>> {
    return this.cache.mget(entries.map((entry) => ({
      ...entry,
      key: this.qualify(entry.key)
    })))
  }

  async mset<T>(entries: CacheMSetEntry<T>[]): Promise<void> {
    await this.cache.mset(entries.map((entry) => ({
      ...entry,
      key: this.qualify(entry.key)
    })))
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
    return this.cache.warm(entries.map((entry) => ({
      ...entry,
      key: this.qualify(entry.key)
    })), options)
  }

  getMetrics(): CacheMetricsSnapshot {
    return this.cache.getMetrics()
  }

  qualify(key: string): string {
    return `${this.prefix}:${key}`
  }
}
