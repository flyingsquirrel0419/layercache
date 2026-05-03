import { describe, expectTypeOf, it } from 'vitest'
import type {
  CacheGenerationCleanupOptions,
  CompressionAlgorithm,
  DiskLayerOptions,
  MemcachedLayerOptions,
  RedisLayerOptions
} from '../src'

describe('public type exports', () => {
  it('exports option types referenced by public constructors and stack options', () => {
    expectTypeOf<CacheGenerationCleanupOptions>().toMatchTypeOf<{ batchSize?: number }>()
    expectTypeOf<CompressionAlgorithm>().toEqualTypeOf<'gzip' | 'brotli'>()
    expectTypeOf<DiskLayerOptions>().toMatchTypeOf<{ directory: string; ttl?: number }>()
    expectTypeOf<MemcachedLayerOptions>().toHaveProperty('client')
    expectTypeOf<RedisLayerOptions>().toHaveProperty('client')
  })
})
