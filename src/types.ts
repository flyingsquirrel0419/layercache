export type CacheValue = Record<string, unknown> | unknown[] | string | number | boolean | null

export interface LayerTtlMap {
  [layerName: string]: number | undefined
}

export interface CacheWriteOptions {
  tags?: string[]
  ttl?: number | LayerTtlMap
  negativeCache?: boolean
  negativeTtl?: number | LayerTtlMap
  staleWhileRevalidate?: number | LayerTtlMap
  staleIfError?: number | LayerTtlMap
  ttlJitter?: number | LayerTtlMap
  slidingTtl?: boolean
  refreshAhead?: number | LayerTtlMap
  adaptiveTtl?: boolean | CacheAdaptiveTtlOptions
  circuitBreaker?: CacheCircuitBreakerOptions
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

export interface CacheLayer {
  readonly name: string
  readonly defaultTtl?: number
  readonly isLocal?: boolean
  get<T>(key: string): Promise<T | null>
  getEntry?<T = unknown>(key: string): Promise<T | null>
  getMany?<T>(keys: string[]): Promise<Array<T | null>>
  set(key: string, value: unknown, ttl?: number): Promise<void>
  delete(key: string): Promise<void>
  clear(): Promise<void>
  deleteMany?(keys: string[]): Promise<void>
  keys?(): Promise<string[]>
}

export interface CacheSerializer {
  serialize(value: unknown): string | Buffer
  deserialize<T>(payload: string | Buffer): T
}

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
  matchPattern(pattern: string): Promise<string[]>
  clear(): Promise<void>
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
  broadcastL1Invalidation?: boolean
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
  singleFlightCoordinator?: CacheSingleFlightCoordinator
  singleFlightLeaseMs?: number
  singleFlightTimeoutMs?: number
  singleFlightPollMs?: number
}

export interface CacheAdaptiveTtlOptions {
  hotAfter?: number
  step?: number | LayerTtlMap
  maxTtl?: number | LayerTtlMap
}

export interface CacheCircuitBreakerOptions {
  failureThreshold?: number
  cooldownMs?: number
}

export interface CacheDegradationOptions {
  retryAfterMs?: number
}

export interface CacheWarmEntry<T = unknown> {
  key: string
  fetcher: () => Promise<T>
  options?: CacheGetOptions
  priority?: number
}

export interface CacheWarmOptions {
  concurrency?: number
  continueOnError?: boolean
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
