import { Mutex } from 'async-mutex'
import type { CacheStack } from './CacheStack'
import type {
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
  private static readonly metricsMutex = new Mutex()
  private metrics: CacheMetricsSnapshot = emptyMetrics()

  constructor(
    private readonly cache: CacheStack,
    private readonly prefix: string
  ) {}

  async get<T>(key: string, fetcher?: () => Promise<T>, options?: CacheGetOptions): Promise<T | null> {
    return this.trackMetrics(() => this.cache.get(this.qualify(key), fetcher, options))
  }

  async getOrSet<T>(key: string, fetcher: () => Promise<T>, options?: CacheGetOptions): Promise<T | null> {
    return this.trackMetrics(() => this.cache.getOrSet(this.qualify(key), fetcher, options))
  }

  /**
   * Like `get()`, but throws `CacheMissError` instead of returning `null`.
   */
  async getOrThrow<T>(key: string, fetcher?: () => Promise<T>, options?: CacheGetOptions): Promise<T> {
    return this.trackMetrics(() => this.cache.getOrThrow(this.qualify(key), fetcher, options))
  }

  async has(key: string): Promise<boolean> {
    return this.trackMetrics(() => this.cache.has(this.qualify(key)))
  }

  async ttl(key: string): Promise<number | null> {
    return this.trackMetrics(() => this.cache.ttl(this.qualify(key)))
  }

  async set<T>(key: string, value: T, options?: CacheWriteOptions): Promise<void> {
    await this.trackMetrics(() => this.cache.set(this.qualify(key), value, options))
  }

  async delete(key: string): Promise<void> {
    await this.trackMetrics(() => this.cache.delete(this.qualify(key)))
  }

  async mdelete(keys: string[]): Promise<void> {
    await this.trackMetrics(() => this.cache.mdelete(keys.map((k) => this.qualify(k))))
  }

  async clear(): Promise<void> {
    await this.trackMetrics(() => this.cache.invalidateByPrefix(this.prefix))
  }

  async mget<T>(entries: CacheMGetEntry<T>[]): Promise<Array<T | null>> {
    return this.trackMetrics(() =>
      this.cache.mget(
        entries.map((entry) => ({
          ...entry,
          key: this.qualify(entry.key)
        }))
      )
    )
  }

  async mset<T>(entries: CacheMSetEntry<T>[]): Promise<void> {
    await this.trackMetrics(() =>
      this.cache.mset(
        entries.map((entry) => ({
          ...entry,
          key: this.qualify(entry.key)
        }))
      )
    )
  }

  async invalidateByTag(tag: string): Promise<void> {
    await this.trackMetrics(() => this.cache.invalidateByTag(tag))
  }

  async invalidateByTags(tags: string[], mode: 'any' | 'all' = 'any'): Promise<void> {
    await this.trackMetrics(() => this.cache.invalidateByTags(tags, mode))
  }

  async invalidateByPattern(pattern: string): Promise<void> {
    await this.trackMetrics(() => this.cache.invalidateByPattern(this.qualify(pattern)))
  }

  async invalidateByPrefix(prefix: string): Promise<void> {
    await this.trackMetrics(() => this.cache.invalidateByPrefix(this.qualify(prefix)))
  }

  /**
   * Returns detailed metadata about a single cache key within this namespace.
   */
  async inspect(key: string): Promise<CacheInspectResult | null> {
    return this.cache.inspect(this.qualify(key))
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
    return cloneMetrics(this.metrics)
  }

  getHitRate(): CacheHitRateSnapshot {
    const total = this.metrics.hits + this.metrics.misses
    const overall = total === 0 ? 0 : this.metrics.hits / total
    const byLayer: Record<string, number> = {}
    const layers = new Set([...Object.keys(this.metrics.hitsByLayer), ...Object.keys(this.metrics.missesByLayer)])
    for (const layer of layers) {
      const hits = this.metrics.hitsByLayer[layer] ?? 0
      const misses = this.metrics.missesByLayer[layer] ?? 0
      byLayer[layer] = hits + misses === 0 ? 0 : hits / (hits + misses)
    }
    return { overall, byLayer }
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
    return new CacheNamespace(this.cache, `${this.prefix}:${childPrefix}`)
  }

  qualify(key: string): string {
    return `${this.prefix}:${key}`
  }

  private async trackMetrics<T>(operation: () => Promise<T>): Promise<T> {
    return CacheNamespace.metricsMutex.runExclusive(async () => {
      const before = this.cache.getMetrics()
      const result = await operation()
      const after = this.cache.getMetrics()
      this.metrics = addMetrics(this.metrics, diffMetrics(before, after))
      return result
    })
  }
}

function emptyMetrics(): CacheMetricsSnapshot {
  return {
    hits: 0,
    misses: 0,
    fetches: 0,
    sets: 0,
    deletes: 0,
    backfills: 0,
    invalidations: 0,
    staleHits: 0,
    refreshes: 0,
    refreshErrors: 0,
    writeFailures: 0,
    singleFlightWaits: 0,
    negativeCacheHits: 0,
    circuitBreakerTrips: 0,
    degradedOperations: 0,
    hitsByLayer: {},
    missesByLayer: {},
    latencyByLayer: {},
    resetAt: Date.now()
  }
}

function cloneMetrics(metrics: CacheMetricsSnapshot): CacheMetricsSnapshot {
  return {
    ...metrics,
    hitsByLayer: { ...metrics.hitsByLayer },
    missesByLayer: { ...metrics.missesByLayer },
    latencyByLayer: Object.fromEntries(
      Object.entries(metrics.latencyByLayer).map(([key, value]) => [key, { ...value }])
    )
  }
}

function diffMetrics(before: CacheMetricsSnapshot, after: CacheMetricsSnapshot): CacheMetricsSnapshot {
  const latencyByLayer = Object.fromEntries(
    Object.entries(after.latencyByLayer).map(([layer, value]) => [
      layer,
      {
        avgMs: value.avgMs,
        maxMs: value.maxMs,
        count: Math.max(0, value.count - (before.latencyByLayer[layer]?.count ?? 0))
      }
    ])
  )

  return {
    hits: after.hits - before.hits,
    misses: after.misses - before.misses,
    fetches: after.fetches - before.fetches,
    sets: after.sets - before.sets,
    deletes: after.deletes - before.deletes,
    backfills: after.backfills - before.backfills,
    invalidations: after.invalidations - before.invalidations,
    staleHits: after.staleHits - before.staleHits,
    refreshes: after.refreshes - before.refreshes,
    refreshErrors: after.refreshErrors - before.refreshErrors,
    writeFailures: after.writeFailures - before.writeFailures,
    singleFlightWaits: after.singleFlightWaits - before.singleFlightWaits,
    negativeCacheHits: after.negativeCacheHits - before.negativeCacheHits,
    circuitBreakerTrips: after.circuitBreakerTrips - before.circuitBreakerTrips,
    degradedOperations: after.degradedOperations - before.degradedOperations,
    hitsByLayer: diffMap(before.hitsByLayer, after.hitsByLayer),
    missesByLayer: diffMap(before.missesByLayer, after.missesByLayer),
    latencyByLayer,
    resetAt: after.resetAt
  }
}

function addMetrics(base: CacheMetricsSnapshot, delta: CacheMetricsSnapshot): CacheMetricsSnapshot {
  return {
    hits: base.hits + delta.hits,
    misses: base.misses + delta.misses,
    fetches: base.fetches + delta.fetches,
    sets: base.sets + delta.sets,
    deletes: base.deletes + delta.deletes,
    backfills: base.backfills + delta.backfills,
    invalidations: base.invalidations + delta.invalidations,
    staleHits: base.staleHits + delta.staleHits,
    refreshes: base.refreshes + delta.refreshes,
    refreshErrors: base.refreshErrors + delta.refreshErrors,
    writeFailures: base.writeFailures + delta.writeFailures,
    singleFlightWaits: base.singleFlightWaits + delta.singleFlightWaits,
    negativeCacheHits: base.negativeCacheHits + delta.negativeCacheHits,
    circuitBreakerTrips: base.circuitBreakerTrips + delta.circuitBreakerTrips,
    degradedOperations: base.degradedOperations + delta.degradedOperations,
    hitsByLayer: addMap(base.hitsByLayer, delta.hitsByLayer),
    missesByLayer: addMap(base.missesByLayer, delta.missesByLayer),
    latencyByLayer: cloneMetrics(delta).latencyByLayer,
    resetAt: base.resetAt
  }
}

function diffMap(before: Record<string, number>, after: Record<string, number>): Record<string, number> {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)])
  const result: Record<string, number> = {}
  for (const key of keys) {
    result[key] = (after[key] ?? 0) - (before[key] ?? 0)
  }
  return result
}

function addMap(base: Record<string, number>, delta: Record<string, number>): Record<string, number> {
  const keys = new Set([...Object.keys(base), ...Object.keys(delta)])
  const result: Record<string, number> = {}
  for (const key of keys) {
    result[key] = (base[key] ?? 0) + (delta[key] ?? 0)
  }
  return result
}
