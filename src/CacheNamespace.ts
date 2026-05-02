import { Mutex } from 'async-mutex'
import type { CacheStack } from './CacheStack'
import {
  addNamespaceMetrics,
  cloneNamespaceMetrics,
  computeNamespaceHitRate,
  createEmptyNamespaceMetrics,
  diffNamespaceMetrics
} from './internal/CacheNamespaceMetrics'
import type {
  CacheFetcher,
  CacheGetOptions,
  CacheHitRateSnapshot,
  CacheInspectResult,
  CacheMGetEntry,
  CacheMSetEntry,
  CacheMetricsSnapshot,
  CacheWarmEntry,
  CacheWarmOptions,
  CacheWrapOptions,
  CacheWriteOptions
} from './types'

export class CacheNamespace {
  private static readonly metricsMutexes = new WeakMap<CacheStack, Mutex>()
  private metrics: CacheMetricsSnapshot = createEmptyNamespaceMetrics()

  constructor(
    private readonly cache: CacheStack,
    private readonly prefix: string
  ) {
    validateNamespaceKey(prefix)
  }

  async get<T>(key: string, fetcher?: CacheFetcher<T>, options?: CacheGetOptions): Promise<T | null> {
    return this.trackMetrics(() => this.cache.get(this.qualify(key), fetcher, this.qualifyGetOptions(options)))
  }

  async getOrSet<T>(key: string, fetcher: CacheFetcher<T>, options?: CacheGetOptions): Promise<T | null> {
    return this.trackMetrics(() => this.cache.getOrSet(this.qualify(key), fetcher, this.qualifyGetOptions(options)))
  }

  /**
   * Like `get()`, but throws `CacheMissError` instead of returning `null`.
   */
  async getOrThrow<T>(key: string, fetcher?: CacheFetcher<T>, options?: CacheGetOptions): Promise<T> {
    return this.trackMetrics(() => this.cache.getOrThrow(this.qualify(key), fetcher, this.qualifyGetOptions(options)))
  }

  async has(key: string): Promise<boolean> {
    return this.trackMetrics(() => this.cache.has(this.qualify(key)))
  }

  async ttl(key: string): Promise<number | null> {
    return this.trackMetrics(() => this.cache.ttl(this.qualify(key)))
  }

  async set<T>(key: string, value: T, options?: CacheWriteOptions): Promise<void> {
    await this.trackMetrics(() => this.cache.set(this.qualify(key), value, this.qualifyWriteOptions(options)))
  }

  async delete(key: string): Promise<void> {
    await this.trackMetrics(() => this.cache.delete(this.qualify(key)))
  }

  async mdelete(keys: string[]): Promise<void> {
    await this.trackMetrics(() => this.cache.mdelete(keys.map((k) => this.qualify(k))))
  }

  async invalidateByKey(key: string): Promise<void> {
    await this.trackMetrics(() => this.cache.invalidateByKey(this.qualify(key)))
  }

  async invalidateByKeys(keys: string[]): Promise<void> {
    await this.trackMetrics(() => this.cache.invalidateByKeys(keys.map((k) => this.qualify(k))))
  }

  async expireByKey(key: string): Promise<void> {
    await this.trackMetrics(() => this.cache.expireByKey(this.qualify(key)))
  }

  async expireByKeys(keys: string[]): Promise<void> {
    await this.trackMetrics(() => this.cache.expireByKeys(keys.map((k) => this.qualify(k))))
  }

  async clear(): Promise<void> {
    await this.trackMetrics(() => this.cache.invalidateByPrefix(this.prefix))
  }

  async mget<T>(entries: CacheMGetEntry<T>[]): Promise<Array<T | null>> {
    return this.trackMetrics(() =>
      this.cache.mget(
        entries.map((entry) => ({
          ...entry,
          key: this.qualify(entry.key),
          options: this.qualifyGetOptions(entry.options)
        }))
      )
    )
  }

  async mset<T>(entries: CacheMSetEntry<T>[]): Promise<void> {
    await this.trackMetrics(() =>
      this.cache.mset(
        entries.map((entry) => ({
          ...entry,
          key: this.qualify(entry.key),
          options: this.qualifyWriteOptions(entry.options)
        }))
      )
    )
  }

  async invalidateByTag(tag: string): Promise<void> {
    await this.trackMetrics(() => this.cache.invalidateByTag(this.qualifyTag(tag)))
  }

  async expireByTag(tag: string): Promise<void> {
    await this.trackMetrics(() => this.cache.expireByTag(this.qualifyTag(tag)))
  }

  async invalidateByTags(tags: string[], mode: 'any' | 'all' = 'any'): Promise<void> {
    await this.trackMetrics(() =>
      this.cache.invalidateByTags(
        tags.map((tag) => this.qualifyTag(tag)),
        mode
      )
    )
  }

  async expireByTags(tags: string[], mode: 'any' | 'all' = 'any'): Promise<void> {
    await this.trackMetrics(() =>
      this.cache.expireByTags(
        tags.map((tag) => this.qualifyTag(tag)),
        mode
      )
    )
  }

  async invalidateByPattern(pattern: string): Promise<void> {
    await this.trackMetrics(() => this.cache.invalidateByPattern(this.qualify(pattern)))
  }

  async expireByPattern(pattern: string): Promise<void> {
    await this.trackMetrics(() => this.cache.expireByPattern(this.qualify(pattern)))
  }

  async invalidateByPrefix(prefix: string): Promise<void> {
    await this.trackMetrics(() => this.cache.invalidateByPrefix(this.qualify(prefix)))
  }

  async expireByPrefix(prefix: string): Promise<void> {
    await this.trackMetrics(() => this.cache.expireByPrefix(this.qualify(prefix)))
  }

  /**
   * Returns detailed metadata about a single cache key within this namespace.
   */
  async inspect(key: string): Promise<CacheInspectResult | null> {
    const result = await this.cache.inspect(this.qualify(key))
    if (result === null) {
      return null
    }

    return {
      ...result,
      tags: result.tags
        .filter((tag) => tag.startsWith(`${this.prefix}:`))
        .map((tag) => tag.slice(this.prefix.length + 1))
    }
  }

  wrap<TArgs extends unknown[], TResult>(
    keyPrefix: string,
    fetcher: (...args: TArgs) => Promise<TResult>,
    options?: CacheWrapOptions<TArgs>
  ): (...args: TArgs) => Promise<TResult | null> {
    return this.cache.wrap(`${this.prefix}:${keyPrefix}`, fetcher, this.qualifyWrapOptions(options))
  }

  warm(entries: CacheWarmEntry[], options?: CacheWarmOptions): Promise<void> {
    return this.cache.warm(
      entries.map((entry) => ({
        ...entry,
        key: this.qualify(entry.key),
        options: this.qualifyGetOptions(entry.options)
      })),
      options
    )
  }

  getMetrics(): CacheMetricsSnapshot {
    return cloneNamespaceMetrics(this.metrics)
  }

  getHitRate(): CacheHitRateSnapshot {
    return computeNamespaceHitRate(this.metrics)
  }

  /**
   * Creates a nested namespace. Keys are prefixed with `parentPrefix:childPrefix:`.
   *
   * ```ts
   * const tenant = cache.namespace('tenant:abc')
   * const posts = tenant.namespace('posts')
   * // keys become: "tenant:abc:posts:mykey"
   * ```
   */
  namespace(childPrefix: string): CacheNamespace {
    validateNamespaceKey(childPrefix)
    return new CacheNamespace(this.cache, `${this.prefix}:${childPrefix}`)
  }

  qualify(key: string): string {
    return `${this.prefix}:${key}`
  }

  private qualifyTag(tag: string): string {
    return `${this.prefix}:${tag}`
  }

  private qualifyGetOptions(options: CacheGetOptions | undefined): CacheGetOptions | undefined {
    return this.qualifyWriteOptions(options)
  }

  private qualifyWrapOptions<TArgs extends unknown[]>(
    options: CacheWrapOptions<TArgs> | undefined
  ): CacheWrapOptions<TArgs> | undefined {
    return this.qualifyWriteOptions(options) as CacheWrapOptions<TArgs> | undefined
  }

  private qualifyWriteOptions<T extends CacheWriteOptions | CacheGetOptions | undefined>(options: T): T {
    if (!options?.tags || options.tags.length === 0) {
      return options
    }

    return {
      ...options,
      tags: options.tags.map((tag) => this.qualifyTag(tag))
    } as T
  }

  private async trackMetrics<T>(operation: () => Promise<T>): Promise<T> {
    return this.getMetricsMutex().runExclusive(async () => {
      const before = this.cache.getMetrics()
      const result = await operation()
      const after = this.cache.getMetrics()
      this.metrics = addNamespaceMetrics(this.metrics, diffNamespaceMetrics(before, after))
      return result
    })
  }

  private getMetricsMutex(): Mutex {
    const existing = CacheNamespace.metricsMutexes.get(this.cache)
    if (existing) {
      return existing
    }

    const mutex = new Mutex()
    CacheNamespace.metricsMutexes.set(this.cache, mutex)
    return mutex
  }
}

export function validateNamespaceKey(key: string): void {
  if (key.length === 0) {
    throw new Error('Namespace prefix must not be empty.')
  }

  if (key.length > 256) {
    throw new Error('Namespace prefix must be at most 256 characters.')
  }

  if (/[\u0000-\u001F\u007F]/.test(key)) {
    throw new Error('Namespace prefix contains unsupported control characters.')
  }

  if (/[\uD800-\uDFFF]/.test(key)) {
    throw new Error('Namespace prefix contains unsupported surrogate code points.')
  }
}
