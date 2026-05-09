/**
 * Values that can be stored in the cache.
 *
 * **Note:** `null` is technically allowed by this type but has ambiguous semantics
 * because `get()` returns `null` to indicate a cache miss. Storing `null` explicitly
 * via `set()` will work, but reading it back will be indistinguishable from a miss.
 * Consider using a sentinel value (e.g. `{ empty: true }`) instead of `null`.
 */
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

/** Per-layer millisecond values keyed by each layer's `name`. */
export interface LayerTtlMap {
  /** Millisecond value for the named layer, or `undefined` to fall back. */
  [layerName: string]: number | undefined
}

/** Internal write classification used when resolving TTLs and entry options. */
export type CacheEntryWriteKind = 'value' | 'empty'

/** Options that describe how a cache entry should be stored. */
export interface CacheEntryWriteOptions {
  /** Tags to associate with the key for tag-based invalidation or expiration. */
  tags?: string[]
  /** Fresh TTL in milliseconds, either uniform or per layer. */
  ttl?: number | LayerTtlMap
  /** Dynamic TTL policy used instead of, or before falling back to, `ttl`. */
  ttlPolicy?: CacheTtlPolicy
  /** TTL in milliseconds for cached null/empty results when negative caching is enabled. */
  negativeTtl?: number | LayerTtlMap
  /** Extra window in milliseconds where stale values are returned while refresh runs in the background. */
  staleWhileRevalidate?: number | LayerTtlMap
  /** Extra window in milliseconds where stale values are returned if refresh fails. */
  staleIfError?: number | LayerTtlMap
  /** Random +/- jitter in milliseconds applied to resolved TTLs to avoid synchronized expiry. */
  ttlJitter?: number | LayerTtlMap
  /** Increase TTL for frequently accessed keys using the adaptive TTL policy. */
  adaptiveTtl?: boolean | CacheAdaptiveTtlOptions
}

/** Context passed to `contextOptions` before a value is written. */
export interface CacheContextOptionsContext {
  /** Fully qualified cache key being written. */
  key: string
  /** Value returned by the fetcher or passed to `set()`. */
  value: unknown
  /** Whether the write stores a normal value or an empty/negative-cache marker. */
  kind: CacheEntryWriteKind
}

/** Options accepted by write operations and read-through fetch writes. */
export interface CacheWriteOptions extends CacheEntryWriteOptions {
  /** Cache `null` fetcher results using `negativeTtl` instead of treating them as misses. */
  negativeCache?: boolean
  /** Cache `null` fetcher results as regular values instead of negative/empty entries. */
  cacheNullValues?: boolean
  /** Extend a key's TTL on fresh reads. */
  slidingTtl?: boolean
  /** Refresh in the background when the remaining TTL is at or below this threshold in milliseconds. */
  refreshAhead?: number | LayerTtlMap
  /** Circuit breaker controls for this operation's fetcher. */
  circuitBreaker?: CacheCircuitBreakerOptions
  /** Rate limit concurrent fetcher execution for this operation. */
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
  /**
   * Optional resolver that can override cache entry options using the current
   * write context. This runs right before a value is stored, so callers can
   * derive TTLs or tags from the fetched value instead of guessing upfront.
   *
   * Returned values override any static entry options already present on the
   * same object. Fetch controls like `shouldCache`, `negativeCache`,
   * `cacheNullValues`,
   * `refreshAhead`, or `circuitBreaker` are not affected.
   *
   * @example
   * cache.get('oauth:token', fetchToken, {
   *   ttl: 300_000,
   *   contextOptions: ({ value }) => ({
   *     ttl: Math.max(1, Math.floor(((value as { refreshExpiresIn: number }).refreshExpiresIn ?? 0) / 1_000))
   *   })
   * })
   */
  contextOptions?: (context: CacheContextOptionsContext) => CacheEntryWriteOptions | undefined
}

/** Options accepted by read-through `get()` operations. */
export interface CacheGetOptions extends CacheWriteOptions {}

/** Metadata passed to a read-through fetcher. */
export interface CacheFetcherContext<T = unknown> {
  /** Fully qualified cache key being fetched. */
  key: string
  /** Existing stale value, when a refresh is triggered from stale state. */
  currentValue: T | undefined
  /** Cache state that caused the fetcher to run. */
  state: 'miss' | 'fresh' | 'stale-while-revalidate' | 'stale-if-error'
  /** Layer that supplied the existing value, when available. */
  layer?: string
}

/** Async function used by read-through cache operations to produce a value on miss or refresh. */
export type CacheFetcher<T = unknown> = (context: CacheFetcherContext<T>) => Promise<T>

/** Entry descriptor for `CacheStack.mget()`. */
export interface CacheMGetEntry<T> {
  /** Cache key to read. */
  key: string
  /** Optional read-through fetcher for this key. */
  fetch?: CacheFetcher<T>
  /** Per-entry get/write options. */
  options?: CacheGetOptions
}

/** Entry descriptor for `CacheStack.mset()`. */
export interface CacheMSetEntry<T> {
  /** Cache key to write. */
  key: string
  /** Value to store. */
  value: T
  /** Per-entry write options. */
  options?: CacheWriteOptions
}

/** Interface that all cache backend implementations must satisfy. */
export interface CacheLayer {
  /** Human-readable unique layer name used for metrics and per-layer options. */
  readonly name: string
  /** Default TTL in milliseconds used when a write does not provide one. */
  readonly defaultTtl?: number
  /** Whether the layer is local to this process, such as memory or disk. */
  readonly isLocal?: boolean
  /** Read and unwrap a fresh value, returning `null` on miss or expiry. */
  get<T>(key: string): Promise<T | null>
  /** Read the raw stored value or envelope so CacheStack can resolve stale state. */
  getEntry?<T = unknown>(key: string): Promise<T | null>
  /**
   * Bulk read fast-path. Implementations should return raw stored entries using
   * the same semantics as `getEntry()` so CacheStack can resolve envelopes,
   * stale windows, and negative-cache markers consistently.
   */
  getMany?<T>(keys: string[]): Promise<Array<T | null>>
  /** Bulk write entries; implementations may use this as an optimized fast path. */
  setMany?(entries: CacheLayerSetManyEntry[]): Promise<void>
  /** Store a raw value for `ttl` milliseconds, or without expiry when omitted. */
  set(key: string, value: unknown, ttl?: number): Promise<void>
  /** Delete a key from this layer. */
  delete(key: string): Promise<void>
  /** Remove all keys from this layer. */
  clear(): Promise<void>
  /** Delete several keys from this layer; CacheStack falls back to `delete()` when absent. */
  deleteMany?(keys: string[]): Promise<void>
  /** Return known keys in this layer for pattern or prefix invalidation. */
  keys?(): Promise<string[]>
  /** Visit known keys without materializing the full key list. */
  forEachKey?(visitor: (key: string) => void | Promise<void>): Promise<void>
  /** Health check hook used by `CacheStack.healthCheck()`. */
  ping?(): Promise<boolean>
  /** Release sockets, timers, or other resources held by the layer. */
  dispose?(): Promise<void>
  /**
   * Returns true if the key exists and has not expired.
   * Implementations may omit this; CacheStack will fall back to `get()`.
   */
  has?(key: string): Promise<boolean>
  /**
   * Returns the remaining TTL in milliseconds for the key, or null if the key
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

/** Serializer used by layers that convert values to bytes or strings. */
export interface CacheSerializer {
  /** Convert a value to a storable payload. */
  serialize(value: unknown): string | Buffer
  /** Restore a value from a payload. */
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
  /** Number of successful cache reads. */
  hits: number
  /** Number of reads that did not find a usable value. */
  misses: number
  /** Number of fetcher executions. */
  fetches: number
  /** Number of cache write operations. */
  sets: number
  /** Number of delete operations. */
  deletes: number
  /** Number of values backfilled from slower layers into faster layers. */
  backfills: number
  /** Number of invalidation operations. */
  invalidations: number
  /** Number of stale values returned to callers. */
  staleHits: number
  /** Number of background refresh attempts. */
  refreshes: number
  /** Number of failed refresh attempts. */
  refreshErrors: number
  /** Number of layer write failures. */
  writeFailures: number
  /** Number of requests that waited for a single-flight result. */
  singleFlightWaits: number
  /** Number of cached negative/empty results served. */
  negativeCacheHits: number
  /** Number of times circuit breakers blocked a fetcher. */
  circuitBreakerTrips: number
  /** Number of operations skipped or retried due to degraded layers. */
  degradedOperations: number
  /** Hit counts grouped by layer name. */
  hitsByLayer: Record<string, number>
  /** Miss counts grouped by layer name. */
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
  /** Low-volume diagnostic events. */
  debug?(message: string, context?: Record<string, unknown>): void
  /** Informational operational messages. */
  info?(message: string, context?: Record<string, unknown>): void
  /** Recoverable problems or risky configuration warnings. */
  warn?(message: string, context?: Record<string, unknown>): void
  /** Errors surfaced by cache operations or layer integrations. */
  error?(message: string, context?: Record<string, unknown>): void
}

/** Index used to map cache keys to tags and discover keys for invalidation. */
export interface CacheTagIndex {
  /** Record that a key exists, even when it has no tags. */
  touch(key: string): Promise<void>
  /** Associate a key with the provided tags, replacing any previous tag set. */
  track(key: string, tags: string[]): Promise<void>
  /** Remove all tag/index metadata for a key. */
  remove(key: string): Promise<void>
  /** Return keys currently associated with a tag. */
  keysForTag(tag: string): Promise<string[]>
  /** Visit keys for a tag without materializing all results. */
  forEachKeyForTag?(tag: string, visitor: (key: string) => void | Promise<void>): Promise<void>
  /** Return known keys with the given prefix. */
  keysForPrefix?(prefix: string): Promise<string[]>
  /** Visit known keys with the given prefix without materializing all results. */
  forEachKeyForPrefix?(prefix: string, visitor: (key: string) => void | Promise<void>): Promise<void>
  /** Returns the tags associated with a specific key, or an empty array. */
  tagsForKey?(key: string): Promise<string[]>
  /** Return known keys matching a wildcard pattern. */
  matchPattern(pattern: string): Promise<string[]>
  /** Visit known keys matching a wildcard pattern without materializing all results. */
  forEachKeyMatchingPattern?(pattern: string, visitor: (key: string) => void | Promise<void>): Promise<void>
  /** Remove all index state. */
  clear(): Promise<void>
}

/** Raw layer bulk-write entry. */
export interface CacheLayerSetManyEntry {
  /** Cache key to write. */
  key: string
  /** Raw value or envelope to store. */
  value: unknown
  /** TTL in milliseconds for this layer entry. */
  ttl?: number
}

/** Cross-process invalidation message sent through an `InvalidationBus`. */
export interface InvalidationMessage {
  /** Message target scope. */
  scope: 'key' | 'keys' | 'clear'
  /** Sender instance id; receivers ignore messages from themselves. */
  sourceId: string
  /** Keys affected by key- or keys-scoped messages. */
  keys?: string[]
  /** Operation that produced this invalidation. */
  operation?: 'write' | 'delete' | 'invalidate' | 'expire' | 'clear'
}

/** Pub/sub abstraction used to broadcast invalidation across CacheStack instances. */
export interface InvalidationBus {
  /** Register a message handler and return an unsubscribe function. */
  subscribe(handler: (message: InvalidationMessage) => Promise<void> | void): Promise<() => Promise<void> | void>
  /** Publish an invalidation message to other subscribers. */
  publish(message: InvalidationMessage): Promise<void>
}

/** Timing controls for a distributed single-flight execution. */
export interface CacheSingleFlightExecutionOptions {
  /** Lease duration in milliseconds for the worker lock. */
  leaseMs: number
  /** Maximum time in milliseconds a waiter should poll for the worker result. */
  waitTimeoutMs: number
  /** Poll interval in milliseconds for waiters. */
  pollIntervalMs: number
  /** Optional interval in milliseconds for renewing a worker lock lease. */
  renewIntervalMs?: number
}

/** Coordinator that deduplicates fetchers across processes. */
export interface CacheSingleFlightCoordinator {
  /** Run `worker` when this process wins the lock, otherwise run `waiter`. */
  execute<T>(
    key: string,
    options: CacheSingleFlightExecutionOptions,
    worker: () => Promise<T>,
    waiter: () => Promise<T>
  ): Promise<T>
}

/** Global options for a `CacheStack` instance. */
export interface CacheStackOptions {
  /** Logger instance, `true` for console debug logging, or `false`/omitted for quiet mode. */
  logger?: CacheLogger | boolean
  /** Enable metrics collection. Currently metrics are always collected; this is kept for API compatibility. */
  metrics?: boolean
  /** Deduplicate concurrent local fetches for the same key. */
  stampedePrevention?: boolean
  /** Maximum number of distinct keys allowed in the local stampede guard. */
  stampedeMaxInFlight?: number
  /** Timeout in milliseconds for a local stampede-guarded fetch. */
  stampedeEntryTimeoutMs?: number
  /** Bus used to receive and publish cross-process invalidation messages. */
  invalidationBus?: InvalidationBus
  /** Tag index implementation used for tag, prefix, and pattern discovery. */
  tagIndex?: CacheTagIndex
  /** Generation number prefixed onto all keys for instant bulk invalidation. */
  generation?: number
  /** Enable cleanup for keys from previous generations. */
  generationCleanup?: boolean | CacheGenerationCleanupOptions
  /** Broadcast writes to other instances so their L1/local layers drop stale values. */
  broadcastL1Invalidation?: boolean
  /**
   * @deprecated Use `broadcastL1Invalidation` instead.
   */
  publishSetInvalidation?: boolean
  /** Cache null fetcher results as negative entries. */
  negativeCaching?: boolean
  /** Cache null fetcher results as regular values instead of negative/empty entries. */
  cacheNullValues?: boolean
  /** Default negative-cache TTL in milliseconds. */
  negativeTtl?: number | LayerTtlMap
  /** Default stale-while-revalidate window in milliseconds. */
  staleWhileRevalidate?: number | LayerTtlMap
  /** Default stale-if-error window in milliseconds. */
  staleIfError?: number | LayerTtlMap
  /** Default TTL jitter in milliseconds. */
  ttlJitter?: number | LayerTtlMap
  /** Default refresh-ahead threshold in milliseconds. */
  refreshAhead?: number | LayerTtlMap
  /** Default adaptive TTL policy. */
  adaptiveTtl?: boolean | CacheAdaptiveTtlOptions
  /** Default circuit breaker settings for fetchers. */
  circuitBreaker?: CacheCircuitBreakerOptions
  /** Keep using healthy layers when another layer fails temporarily. */
  gracefulDegradation?: boolean | CacheDegradationOptions
  /** Write behavior: fail on any layer error (`strict`) or only if all layers fail (`best-effort`). */
  writePolicy?: 'strict' | 'best-effort'
  /** Write immediately to all layers or queue writes behind the response path. */
  writeStrategy?: 'write-through' | 'write-behind'
  /** Queue controls used when `writeStrategy` is `write-behind`. */
  writeBehind?: CacheWriteBehindOptions
  /** Default fetcher rate limit settings. */
  fetcherRateLimit?: CacheRateLimitOptions
  /** Max milliseconds allowed for background refresh before it is aborted. */
  backgroundRefreshTimeoutMs?: number
  /** Coordinator used for distributed single-flight fetcher deduplication. */
  singleFlightCoordinator?: CacheSingleFlightCoordinator
  /** Distributed single-flight lock lease in milliseconds. */
  singleFlightLeaseMs?: number
  /** Maximum milliseconds waiters poll for distributed single-flight completion. */
  singleFlightTimeoutMs?: number
  /** Poll interval in milliseconds for distributed single-flight waiters. */
  singleFlightPollMs?: number
  /** Interval in milliseconds for renewing distributed single-flight leases. */
  singleFlightRenewIntervalMs?: number
  /** Base directory that constrains snapshot persistence paths, or `false` to disable path sandboxing. */
  snapshotBaseDir?: string | false
  /** Maximum snapshot file size in bytes accepted during restore, or `false` to disable. */
  snapshotMaxBytes?: number | false
  /** Maximum number of entries exported or imported in one snapshot, or `false` to disable. */
  snapshotMaxEntries?: number | false
  /** Maximum keys one invalidation scan may affect, or `false` to disable the guard. */
  invalidationMaxKeys?: number | false
  /**
   * Maximum number of entries in `accessProfiles` and `circuitBreakers` maps
   * before the oldest entries are pruned. Prevents unbounded memory growth.
   * Defaults to 100 000.
   */
  maxProfileEntries?: number
}

/** Adaptive TTL policy settings for hot keys. */
export interface CacheAdaptiveTtlOptions {
  /** Number of accesses after which a key is considered hot. */
  hotAfter?: number
  /** TTL increment in milliseconds, uniform or per layer. */
  step?: number | LayerTtlMap
  /** Maximum TTL in milliseconds after adaptive increases. */
  maxTtl?: number | LayerTtlMap
}

/** Options for pruning keys from older generations. */
export interface CacheGenerationCleanupOptions {
  /** Number of old-generation keys to remove per cleanup batch. */
  batchSize?: number
}

/** Built-in TTL policies or a function that returns a TTL in milliseconds. */
export type CacheTtlPolicy =
  | 'until-midnight'
  | 'next-hour'
  | { alignTo: number }
  | ((context: CacheTtlPolicyContext) => number | undefined)

/** Context passed to a custom TTL policy. */
export interface CacheTtlPolicyContext {
  /** Fully qualified cache key being written. */
  key: string
  /** Value being written. */
  value: unknown
}

/** Circuit breaker settings for protecting failing fetchers. */
export interface CacheCircuitBreakerOptions {
  /** Consecutive failures before the circuit opens. */
  failureThreshold?: number
  /** Milliseconds before an open circuit allows another attempt. */
  cooldownMs?: number
}

/** Graceful degradation settings for temporarily unhealthy layers. */
export interface CacheDegradationOptions {
  /** Milliseconds to skip a failed layer before trying it again. */
  retryAfterMs?: number
}

/** Fetcher concurrency/rate limiting settings. */
export interface CacheRateLimitOptions {
  /** Maximum concurrent fetchers allowed in the selected scope. */
  maxConcurrent?: number
  /** Window size in milliseconds for `maxPerInterval`. */
  intervalMs?: number
  /** Maximum fetches allowed per interval window. */
  maxPerInterval?: number
  /** Whether limits apply globally, per cache key, or per fetcher function. */
  scope?: 'global' | 'key' | 'fetcher'
  /** Custom bucket id used to group otherwise unrelated fetches. */
  bucketKey?: string
}

/** Queue controls for write-behind mode. */
export interface CacheWriteBehindOptions {
  /** Milliseconds between automatic queue flushes. */
  flushIntervalMs?: number
  /** Maximum entries flushed in one batch. */
  batchSize?: number
  /** Maximum queued writes before new writes are rejected. */
  maxQueueSize?: number
}

/** Entry used by `CacheStack.warm()` to pre-populate a key. */
export interface CacheWarmEntry<T = unknown> {
  /** Cache key to warm. */
  key: string
  /** Fetcher used to produce the value. */
  fetcher: CacheFetcher<T>
  /** Cache options applied while warming this entry. */
  options?: CacheGetOptions
  /** Higher priority entries are warmed first. */
  priority?: number
}

/** Options controlling the cache warm-up process. */
export interface CacheWarmOptions {
  /** Number of warm fetchers to run concurrently. Defaults to 4. */
  concurrency?: number
  /** Continue warming remaining entries after an entry fails. */
  continueOnError?: boolean
  /** Called after each entry is processed (success or failure). */
  onProgress?: (progress: CacheWarmProgress) => void
}

/** Progress information delivered to `CacheWarmOptions.onProgress`. */
export interface CacheWarmProgress {
  /** Number of entries processed so far. */
  completed: number
  /** Total entries scheduled for warming. */
  total: number
  /** Key that just finished processing. */
  key: string
  /** Whether the key was warmed successfully. */
  success: boolean
}

/** Options for `CacheStack.wrap()` and `CacheNamespace.wrap()`. */
export interface CacheWrapOptions<TArgs extends unknown[] = unknown[]> extends CacheGetOptions {
  /** Converts wrapper function arguments into a cache key suffix. */
  keyResolver?: (...args: TArgs) => string
}

/** Entry exported by snapshot APIs. */
export interface CacheSnapshotEntry {
  /** Cache key. */
  key: string
  /** Stored value or envelope. */
  value: unknown
  /** Remaining TTL in milliseconds, when available. */
  ttl?: number
}

/** Snapshot of metrics, layer health state, and active background work. */
export interface CacheStatsSnapshot {
  /** Current cumulative metrics. */
  metrics: CacheMetricsSnapshot
  /** Layer-level runtime state. */
  layers: Array<{
    /** Layer name. */
    name: string
    /** Whether the layer is local to this process. */
    isLocal: boolean
    /** Timestamp in milliseconds until which the layer is degraded, or null. */
    degradedUntil: number | null
  }>
  /** Number of background refreshes currently running. */
  backgroundRefreshes: number
}

/** Result returned by `CacheStack.healthCheck()`. */
export interface CacheHealthCheckResult {
  /** Layer name. */
  layer: string
  /** Whether the layer responded successfully. */
  healthy: boolean
  /** Time spent checking this layer in milliseconds. */
  latencyMs: number
  /** Failure message when `healthy` is false. */
  error?: string
}

/** Detailed inspection result for a single cache key. */
export interface CacheInspectResult {
  /** User-facing cache key. */
  key: string
  /** Layers in which the key is currently stored (not expired). */
  foundInLayers: string[]
  /** Remaining fresh TTL in milliseconds, or null if no expiry or not an envelope. */
  freshTtlMs: number | null
  /** Remaining stale-while-revalidate window in milliseconds, or null. */
  staleTtlMs: number | null
  /** Remaining stale-if-error window in milliseconds, or null. */
  errorTtlMs: number | null
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
  /** Fired after one or more keys are marked expired but retained. */
  expire: { keys: string[] }
  /** Fired when a value is backfilled into a faster layer. */
  backfill: { key: string; layer: string }
  /** Fired when a stale value is returned to the caller. */
  'stale-serve': { key: string; state: string; layer: string }
  /** Fired when a duplicate request is deduplicated in stampede prevention. */
  'stampede-dedupe': { key: string }
  /** Fired after a key is successfully warmed. */
  warm: { key: string }
  /** Fired immediately before a high-level cache operation begins. */
  'operation-start': { id: number; name: string; attributes?: Record<string, unknown> }
  /** Fired after a high-level cache operation finishes. */
  'operation-end': {
    id: number
    name: string
    attributes?: Record<string, unknown>
    success: boolean
    result?: 'null'
    error?: unknown
  }
  /** Fired when an error occurs (layer failure, circuit breaker, etc.). */
  error: { operation: string; [key: string]: unknown }
}
