export type CacheValue = Record<string, unknown> | unknown[] | string | number | boolean | null

export interface LayerTtlMap {
  [layerName: string]: number | undefined
}

export interface CacheWriteOptions {
  tags?: string[]
  ttl?: number | LayerTtlMap
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
}

export interface CacheLogger {
  debug(message: string, context?: Record<string, unknown>): void
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

export interface CacheBridgeOptions {
  logger?: CacheLogger | boolean
  metrics?: boolean
  stampedePrevention?: boolean
  invalidationBus?: InvalidationBus
  tagIndex?: CacheTagIndex
  publishSetInvalidation?: boolean
}
