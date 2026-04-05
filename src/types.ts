export type CacheValue = Record<string, unknown> | unknown[] | string | number | boolean | null

/**
 * Thrown by `CacheStack.getOrThrow()` when no value is found for the given key
 * (fetcher returned null or no fetcher was provided and the key is absent).
 */
export class CacheMissError extends Error {
  readonly key: string

  constructor(key: string) {
    super(`Cache miss for key "${key}".`)
    this.name = 'CacheMissError'
    this.key = key
  }
}

export interface LayerTtlMap {
  [layerName: string]: number | undefined
}

export interface CacheWriteOptions {
  tags?: string[]
  ttl?: number | LayerTtlMap
  ttlPolicy?: CacheTtlPolicy
  negativeCache?: boolean
  negativeTtl?: number | LayerTtlMap
  staleWhileRevalidate?: number | LayerTtlMap
  staleIfError?: number | LayerTtlMap
  ttlJitter?: number | LayerTtlMap
  slidingTtl?: boolean
  refreshAhead?: number | LayerTtlMap
  adaptiveTtl?: boolean | CacheAdaptiveTtlOptions
  circuitBreaker?: CacheCircuitBreakerOptions
  fetcherRateLimit?: CacheRateLimitOptions
  /**
   * Optional predicate called with the fetcher's return value before caching.
   * Return `false` to skip storing the value in the cache (but still return it
   * to the caller). Useful for not caching failed API responses or empty results.
   *
   * @example
   * cache.get('key', fetchData, { shouldCache: (v) => v.status === 200 })
   */
  shouldCache?: (value: unknown) => boolean
}

export interface CacheGetOptions extends CacheWriteOptions {}

export interface CacheMGetEntry<T> {
  key: string
  fetch?: () => Promise<T>
  options?: CacheGetOptions
}

export interface CacheMSetEntry<T> {
  key: string
  value: T
  options?: CacheWriteOptions
}

/** Interface that all cache backend implementations must satisfy. */
export interface CacheLayer {
  readonly name: string
  readonly defaultTtl?: number
  readonly isLocal?: boolean
  get<T>(key: string): Promise<T | null>
  getEntry?<T = unknown>(key: string): Promise<T | null>
  /**
   * Bulk read fast-path. Implementations should return raw stored entries using
   * the same semantics as `getEntry()` so CacheStack can resolve envelopes,
   * stale windows, and negative-cache markers consistently.
   */
  getMany?<T>(keys: string[]): Promise<Array<T | null>>
  setMany?(entries: CacheLayerSetManyEntry[]): Promise<void>
  set(key: string, value: unknown, ttl?: number): Promise<void>
  delete(key: string): Promise<void>
  clear(): Promise<void>
  deleteMany?(keys: string[]): Promise<void>
  keys?(): Promise<string[]>
  ping?(): Promise<boolean>
  dispose?(): Promise<void>
  /**
   * Returns true if the key exists and has not expired.
   * Implementations may omit this; CacheStack will fall back to `get()`.
   */
  has?(key: string): Promise<boolean>
  /**
   * Returns the remaining TTL in seconds for the key, or null if the key
   * does not exist, has no TTL, or has already expired.
   * Implementations may omit this.
   */
  ttl?(key: string): Promise<number | null>
  /**
   * Returns the number of entries currently held by this layer.
   * Implementations may omit this.
   */
  size?(): Promise<number>
}

export interface CacheSerializer {
  serialize(value: unknown): string | Buffer
  deserialize<T>(payload: string | Buffer): T
}

/** Per-layer latency statistics (rolling window of sampled read durations). */
export interface CacheLayerLatency {
  /** Average read latency in milliseconds. */
  avgMs: number
  /** Maximum observed read latency in milliseconds. */
  maxMs: number
  /** Number of samples used to compute the statistics. */
  count: number
}

/** Snapshot of cumulative cache counters. */
export interface CacheMetricsSnapshot {
  hits: number
  misses: number
  fetches: number
  sets: number
  deletes: number
  backfills: number
  invalidations: number
  staleHits: number
  refreshes: number
  refreshErrors: number
  writeFailures: number
  singleFlightWaits: number
  negativeCacheHits: number
  circuitBreakerTrips: number
  degradedOperations: number
  hitsByLayer: Record<string, number>
  missesByLayer: Record<string, number>
  /** Per-layer read latency statistics (sampled from successful reads). */
  latencyByLayer: Record<string, CacheLayerLatency>
  /** Timestamp (ms since epoch) when metrics were last reset. */
  resetAt: number
}

/** Computed hit-rate statistics derived from CacheMetricsSnapshot. */
export interface CacheHitRateSnapshot {
  /** Overall hit rate across all layers (0–1). */
  overall: number
  /** Per-layer hit rates (0–1 each). */
  byLayer: Record<string, number>
}

export interface CacheLogger {
  debug?(message: string, context?: Record<string, unknown>): void
  info?(message: string, context?: Record<string, unknown>): void
  warn?(message: string, context?: Record<string, unknown>): void
  error?(message: string, context?: Record<string, unknown>): void
}

export interface CacheTagIndex {
  touch(key: string): Promise<void>
  track(key: string, tags: string[]): Promise<void>
  remove(key: string): Promise<void>
  keysForTag(tag: string): Promise<string[]>
  keysForPrefix?(prefix: string): Promise<string[]>
  /** Returns the tags associated with a specific key, or an empty array. */
  tagsForKey?(key: string): Promise<string[]>
  matchPattern(pattern: string): Promise<string[]>
  clear(): Promise<void>
}

export interface CacheLayerSetManyEntry {
  key: string
  value: unknown
  ttl?: number
}

export interface InvalidationMessage {
  scope: 'key' | 'keys' | 'clear'
  sourceId: string
  keys?: string[]
  operation?: 'write' | 'delete' | 'invalidate' | 'clear'
}

export interface InvalidationBus {
  subscribe(handler: (message: InvalidationMessage) => Promise<void> | void): Promise<() => Promise<void> | void>
  publish(message: InvalidationMessage): Promise<void>
}

export interface CacheSingleFlightExecutionOptions {
  leaseMs: number
  waitTimeoutMs: number
  pollIntervalMs: number
}

export interface CacheSingleFlightCoordinator {
  execute<T>(
    key: string,
    options: CacheSingleFlightExecutionOptions,
    worker: () => Promise<T>,
    waiter: () => Promise<T>
  ): Promise<T>
}

export interface CacheStackOptions {
  logger?: CacheLogger | boolean
  metrics?: boolean
  stampedePrevention?: boolean
  invalidationBus?: InvalidationBus
  tagIndex?: CacheTagIndex
  generation?: number
  broadcastL1Invalidation?: boolean
  /**
   * @deprecated Use `broadcastL1Invalidation` instead.
   */
  publishSetInvalidation?: boolean
  negativeCaching?: boolean
  negativeTtl?: number | LayerTtlMap
  staleWhileRevalidate?: number | LayerTtlMap
  staleIfError?: number | LayerTtlMap
  ttlJitter?: number | LayerTtlMap
  refreshAhead?: number | LayerTtlMap
  adaptiveTtl?: boolean | CacheAdaptiveTtlOptions
  circuitBreaker?: CacheCircuitBreakerOptions
  gracefulDegradation?: boolean | CacheDegradationOptions
  writePolicy?: 'strict' | 'best-effort'
  writeStrategy?: 'write-through' | 'write-behind'
  writeBehind?: CacheWriteBehindOptions
  fetcherRateLimit?: CacheRateLimitOptions
  singleFlightCoordinator?: CacheSingleFlightCoordinator
  singleFlightLeaseMs?: number
  singleFlightTimeoutMs?: number
  singleFlightPollMs?: number
  /**
   * Maximum number of entries in `accessProfiles` and `circuitBreakers` maps
   * before the oldest entries are pruned. Prevents unbounded memory growth.
   * Defaults to 100 000.
   */
  maxProfileEntries?: number
}

export interface CacheAdaptiveTtlOptions {
  hotAfter?: number
  step?: number | LayerTtlMap
  maxTtl?: number | LayerTtlMap
}

export type CacheTtlPolicy =
  | 'until-midnight'
  | 'next-hour'
  | { alignTo: number }
  | ((context: CacheTtlPolicyContext) => number | undefined)

export interface CacheTtlPolicyContext {
  key: string
  value: unknown
}

export interface CacheCircuitBreakerOptions {
  failureThreshold?: number
  cooldownMs?: number
}

export interface CacheDegradationOptions {
  retryAfterMs?: number
}

export interface CacheRateLimitOptions {
  maxConcurrent?: number
  intervalMs?: number
  maxPerInterval?: number
}

export interface CacheWriteBehindOptions {
  flushIntervalMs?: number
  batchSize?: number
  maxQueueSize?: number
}

export interface CacheWarmEntry<T = unknown> {
  key: string
  fetcher: () => Promise<T>
  options?: CacheGetOptions
  priority?: number
}

/** Options controlling the cache warm-up process. */
export interface CacheWarmOptions {
  concurrency?: number
  continueOnError?: boolean
  /** Called after each entry is processed (success or failure). */
  onProgress?: (progress: CacheWarmProgress) => void
}

/** Progress information delivered to `CacheWarmOptions.onProgress`. */
export interface CacheWarmProgress {
  completed: number
  total: number
  key: string
  success: boolean
}

export interface CacheWrapOptions<TArgs extends unknown[] = unknown[]> extends CacheGetOptions {
  keyResolver?: (...args: TArgs) => string
}

export interface CacheSnapshotEntry {
  key: string
  value: unknown
  ttl?: number
}

export interface CacheStatsSnapshot {
  metrics: CacheMetricsSnapshot
  layers: Array<{
    name: string
    isLocal: boolean
    degradedUntil: number | null
  }>
  backgroundRefreshes: number
}

export interface CacheHealthCheckResult {
  layer: string
  healthy: boolean
  latencyMs: number
  error?: string
}

/** Detailed inspection result for a single cache key. */
export interface CacheInspectResult {
  key: string
  /** Layers in which the key is currently stored (not expired). */
  foundInLayers: string[]
  /** Remaining fresh TTL in seconds, or null if no expiry or not an envelope. */
  freshTtlSeconds: number | null
  /** Remaining stale-while-revalidate window in seconds, or null. */
  staleTtlSeconds: number | null
  /** Remaining stale-if-error window in seconds, or null. */
  errorTtlSeconds: number | null
  /** Whether the key is currently serving stale-while-revalidate. */
  isStale: boolean
  /** Tags associated with this key (from the TagIndex). */
  tags: string[]
}

// ---------------------------------------------------------------------------
// Typed EventEmitter events
// ---------------------------------------------------------------------------

/** All events emitted by CacheStack and their payload shapes. */
export interface CacheStackEvents {
  /** Fired on every cache hit. */
  hit: { key: string; layer: string; state: 'fresh' | 'stale-while-revalidate' | 'stale-if-error' }
  /** Fired on every cache miss before the fetcher runs. */
  miss: { key: string; mode: string }
  /** Fired after a value is stored in the cache. */
  set: { key: string; kind: string; tags?: string[] }
  /** Fired after one or more keys are deleted. */
  delete: { keys: string[] }
  /** Fired when a value is backfilled into a faster layer. */
  backfill: { key: string; layer: string }
  /** Fired when a stale value is returned to the caller. */
  'stale-serve': { key: string; state: string; layer: string }
  /** Fired when a duplicate request is deduplicated in stampede prevention. */
  'stampede-dedupe': { key: string }
  /** Fired after a key is successfully warmed. */
  warm: { key: string }
  /** Fired when an error occurs (layer failure, circuit breaker, etc.). */
  error: { operation: string; [key: string]: unknown }
}
