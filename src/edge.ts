export { MemoryLayer } from './layers/MemoryLayer'
export type { EvictionPolicy, MemoryLayerOptions, MemoryLayerSnapshotEntry } from './layers/MemoryLayer'
export { PatternMatcher } from './invalidation/PatternMatcher'
export { TagIndex } from './invalidation/TagIndex'
export { createHonoCacheMiddleware } from './integrations/hono'
export type {
  CacheGetOptions,
  CacheLayer,
  CacheLayerSetManyEntry,
  CacheMetricsSnapshot,
  CacheRateLimitOptions,
  CacheContextOptionsContext,
  CacheEntryWriteKind,
  CacheEntryWriteOptions,
  CacheTtlPolicy,
  CacheTtlPolicyContext,
  CacheWriteOptions
} from './types'
