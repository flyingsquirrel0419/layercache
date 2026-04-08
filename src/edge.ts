import { createHonoCacheMiddleware } from './integrations/hono'
import { PatternMatcher } from './invalidation/PatternMatcher'
import { TagIndex } from './invalidation/TagIndex'
import { MemoryLayer } from './layers/MemoryLayer'

export { MemoryLayer } from './layers/MemoryLayer'
export type { EvictionPolicy, MemoryLayerOptions, MemoryLayerSnapshotEntry } from './layers/MemoryLayer'
export { PatternMatcher } from './invalidation/PatternMatcher'
export { TagIndex } from './invalidation/TagIndex'
export { createHonoCacheMiddleware } from './integrations/hono'
void [MemoryLayer, PatternMatcher, TagIndex, createHonoCacheMiddleware]
export type {
  CacheGetOptions,
  CacheLayer,
  CacheLayerSetManyEntry,
  CacheMetricsSnapshot,
  CacheRateLimitOptions,
  CacheTtlPolicy,
  CacheTtlPolicyContext,
  CacheWriteOptions
} from './types'
