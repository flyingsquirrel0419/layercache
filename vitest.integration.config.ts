import { defineConfig } from 'vitest/config'

// Unit test files that also run 1:1 against real Redis. tests/setup.real-redis.ts
// swaps the mocked 'ioredis' module for the actual client, so the exact same
// tests execute against a live server. Add new redis-backed unit test files here.
const REAL_REDIS_MIRRORED_TESTS = [
  'tests/CacheStack.test.ts',
  'tests/layers/RedisLayer.test.ts',
  'tests/layers/RedisLayer.compression.test.ts',
  'tests/invalidation/RedisInvalidationBus.test.ts',
  'tests/invalidation/RedisTagIndex.test.ts',
  'tests/features/GrowthFeatures.test.ts',
  'tests/features/OperationalFeatures.test.ts',
  'tests/integration/MultiLayerCache.test.ts'
]

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'redis-integration',
          include: ['tests/integration/redis/**/*.test.ts'],
          setupFiles: ['./tests/integration-setup.ts'],
          testTimeout: 30_000,
          environment: 'node',
          globals: true
        }
      },
      {
        test: {
          name: 'real-redis-mirror',
          include: REAL_REDIS_MIRRORED_TESTS,
          setupFiles: ['./tests/setup.real-redis.ts'],
          testTimeout: 30_000,
          environment: 'node',
          globals: true
        }
      }
    ]
  }
})
