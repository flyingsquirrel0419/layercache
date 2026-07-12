import { defineConfig } from 'vitest/config'

// Unit test files that also run 1:1 against real Redis. The LAYERCACHE_TEST_REDIS=real
// env makes tests/helpers/test-redis.ts createTestRedis() return real ioredis clients,
// so the exact same tests execute against a live server. Add new redis-backed unit
// test files here. Real-only blocks use realRedisTest.describe / realRedisTest.it and
// are skipped under the mock unit suite.
const REAL_REDIS_MIRRORED_TESTS = [
  'tests/CacheStack.test.ts',
  'tests/layers/RedisLayer.test.ts',
  'tests/layers/RedisLayer.compression.test.ts',
  'tests/invalidation/RedisInvalidationBus.test.ts',
  'tests/invalidation/RedisTagIndex.test.ts',
  'tests/singleflight/RedisSingleFlightCoordinator.test.ts',
  'tests/features/GrowthFeatures.test.ts',
  'tests/features/OperationalFeatures.test.ts',
  'tests/integration/MultiLayerCache.test.ts'
]

export default defineConfig({
  test: {
    globalSetup: ['./tests/global-setup.real-redis.ts'],
    projects: [
      {
        test: {
          name: 'real-redis',
          include: [...REAL_REDIS_MIRRORED_TESTS],
          setupFiles: ['./tests/setup.real-redis.ts'],
          env: {
            LAYERCACHE_TEST_REDIS: 'real',
            REDIS_AVAILABLE: '1'
          },
          testTimeout: 30_000,
          environment: 'node',
          globals: true
        }
      }
    ]
  }
})
