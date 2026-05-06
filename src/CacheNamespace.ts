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
  CacheEntryResult,
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

/**
 * Prefix-scoped view over a `CacheStack`.
 *
 * All keys and tags passed through the namespace are qualified with the
 * namespace prefix, while metrics are tracked separately for namespace usage.
 */
export class CacheNamespace {
  private static readonly metricsMutexes = new WeakMap<CacheStack, Mutex>()
  private metrics: CacheMetricsSnapshot = createEmptyNamespaceMetrics()

  /**
   * Creates a namespace backed by an existing cache stack.
   */
  constructor(
    private readonly cache: CacheStack,
    private readonly prefix: string
  ) {
    validateNamespaceKey(prefix)
  }

  /**
   * Reads a key inside this namespace and optionally runs a read-through fetcher
   * on miss or refresh.
   */
  async get<T>(key: string, fetcher?: CacheFetcher<T>, options?: CacheGetOptions): Promise<T | null> {
    return this.trackMetrics(() => this.cache.get(this.qualify(key), fetcher, this.qualifyGetOptions(options)))
  }

  /**
   * Alias for `get(key, fetcher, options)` that makes the get-or-set behavior explicit.
   */
  async getOrSet<T>(key: string, fetcher: CacheFetcher<T>, options?: CacheGetOptions): Promise<T | null> {
    return this.trackMetrics(() => this.cache.getOrSet(this.qualify(key), fetcher, this.qualifyGetOptions(options)))
  }

  /**
   * Returns a namespaced cache entry, or `null` on miss.
   * Unlike `get()`, this distinguishes a stored `null` value from an absent key.
   */
  async getEntry<T>(key: string): Promise<CacheEntryResult<T> | null> {
    const entry = await this.trackMetrics(() => this.cache.getEntry<T>(this.qualify(key)))
    if (entry === null) {
      return null
    }

    return {
      ...entry,
      key
    }
  }

  /**
   * Like `get()`, but throws `CacheMissError` instead of returning `null`.
   */
  async getOrThrow<T>(key: string, fetcher?: CacheFetcher<T>, options?: CacheGetOptions): Promise<T> {
    return this.trackMetrics(() => this.cache.getOrThrow(this.qualify(key), fetcher, this.qualifyGetOptions(options)))
  }

  /**
   * Returns true when the namespaced key exists and has not expired in any layer.
   */
  async has(key: string): Promise<boolean> {
    return this.trackMetrics(() => this.cache.has(this.qualify(key)))
  }

  /**
   * Returns the remaining TTL in milliseconds for the namespaced key.
   */
  async ttl(key: string): Promise<number | null> {
    return this.trackMetrics(() => this.cache.ttl(this.qualify(key)))
  }

  /**
   * Stores a value under a namespaced key.
   */
  async set<T>(key: string, value: T, options?: CacheWriteOptions): Promise<void> {
    await this.trackMetrics(() => this.cache.set(this.qualify(key), value, this.qualifyWriteOptions(options)))
  }

  /**
   * Deletes a namespaced key from all layers.
   */
  async delete(key: string): Promise<void> {
    await this.trackMetrics(() => this.cache.delete(this.qualify(key)))
  }

  /**
   * Deletes multiple namespaced keys from all layers.
   */
  async mdelete(keys: string[]): Promise<void> {
    await this.trackMetrics(() => this.cache.mdelete(keys.map((k) => this.qualify(k))))
  }

  /**
   * Alias for `delete(key)` scoped to this namespace.
   */
  async invalidateByKey(key: string): Promise<void> {
    await this.trackMetrics(() => this.cache.invalidateByKey(this.qualify(key)))
  }

  /**
   * Alias for `mdelete(keys)` scoped to this namespace.
   */
  async invalidateByKeys(keys: string[]): Promise<void> {
    await this.trackMetrics(() => this.cache.invalidateByKeys(keys.map((k) => this.qualify(k))))
  }

  /**
   * Marks one exact namespaced key expired without deleting its stale value.
   */
  async expireByKey(key: string): Promise<void> {
    await this.trackMetrics(() => this.cache.expireByKey(this.qualify(key)))
  }

  /**
   * Marks multiple exact namespaced keys expired without deleting their stale values.
   */
  async expireByKeys(keys: string[]): Promise<void> {
    await this.trackMetrics(() => this.cache.expireByKeys(keys.map((k) => this.qualify(k))))
  }

  /**
   * Clears all keys in this namespace by invalidating the namespace prefix.
   */
  async clear(): Promise<void> {
    await this.trackMetrics(() => this.cache.invalidateByPrefix(this.prefix))
  }

  /**
   * Reads many namespaced keys concurrently.
   */
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

  /**
   * Writes many namespaced entries concurrently.
   */
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

  /**
   * Deletes keys associated with a tag scoped to this namespace.
   */
  async invalidateByTag(tag: string): Promise<void> {
    await this.trackMetrics(() => this.cache.invalidateByTag(this.qualifyTag(tag)))
  }

  /**
   * Expires keys associated with a tag scoped to this namespace while preserving stale windows.
   */
  async expireByTag(tag: string): Promise<void> {
    await this.trackMetrics(() => this.cache.expireByTag(this.qualifyTag(tag)))
  }

  /**
   * Deletes keys associated with any or all namespace-scoped tags.
   */
  async invalidateByTags(tags: string[], mode: 'any' | 'all' = 'any'): Promise<void> {
    await this.trackMetrics(() =>
      this.cache.invalidateByTags(
        tags.map((tag) => this.qualifyTag(tag)),
        mode
      )
    )
  }

  /**
   * Expires keys associated with any or all namespace-scoped tags while preserving stale windows.
   */
  async expireByTags(tags: string[], mode: 'any' | 'all' = 'any'): Promise<void> {
    await this.trackMetrics(() =>
      this.cache.expireByTags(
        tags.map((tag) => this.qualifyTag(tag)),
        mode
      )
    )
  }

  /**
   * Deletes namespaced keys matching a wildcard pattern.
   */
  async invalidateByPattern(pattern: string): Promise<void> {
    await this.trackMetrics(() => this.cache.invalidateByPattern(this.qualify(pattern)))
  }

  /**
   * Expires namespaced keys matching a wildcard pattern while preserving stale windows.
   */
  async expireByPattern(pattern: string): Promise<void> {
    await this.trackMetrics(() => this.cache.expireByPattern(this.qualify(pattern)))
  }

  /**
   * Deletes namespaced keys with the provided prefix.
   */
  async invalidateByPrefix(prefix: string): Promise<void> {
    await this.trackMetrics(() => this.cache.invalidateByPrefix(this.qualify(prefix)))
  }

  /**
   * Expires namespaced keys with the provided prefix while preserving stale windows.
   */
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

  /**
   * Returns a cached wrapper whose generated keys are scoped to this namespace.
   */
  wrap<TArgs extends unknown[], TResult>(
    keyPrefix: string,
    fetcher: (...args: TArgs) => Promise<TResult>,
    options?: CacheWrapOptions<TArgs>
  ): (...args: TArgs) => Promise<TResult | null> {
    return this.cache.wrap(`${this.prefix}:${keyPrefix}`, fetcher, this.qualifyWrapOptions(options))
  }

  /**
   * Warms entries after qualifying each key and tag with this namespace prefix.
   */
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

  /**
   * Returns metrics accumulated by operations performed through this namespace.
   */
  getMetrics(): CacheMetricsSnapshot {
    return cloneNamespaceMetrics(this.metrics)
  }

  /**
   * Returns hit-rate statistics for operations performed through this namespace.
   */
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

  /**
   * Qualifies a raw key with this namespace prefix.
   */
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
