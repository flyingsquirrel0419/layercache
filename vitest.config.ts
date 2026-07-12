import { defineConfig } from 'vitest/config'

// Unit test files that also run 1:1 against real Redis. The LAYERCACHE_TEST_REDIS=real
// env makes tests/helpers/test-redis.ts createTestRedis() return real ioredis clients,
// so the exact same tests execute against a live server. Add new redis-backed unit
// test files here. Real-only blocks use realRedisTest.describe / realRedisTest.it and
// are skipped under the unit project.
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
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/cli.ts', 'src/index.ts', 'src/edge.ts']
    },
    projects: [
      {
        test: {
          name: 'unit',
          setupFiles: ['./tests/setup.ts'],
          exclude: ['**/node_modules/**', '**/dist/**', '**/docs-web/**'],
          environment: 'node',
          globals: true
        }
      },
      {
        test: {
          name: 'real-redis',
          include: [...REAL_REDIS_MIRRORED_TESTS],
          setupFiles: ['./tests/setup.real-redis.ts'],
          globalSetup: ['./tests/global-setup.real-redis.ts'],
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
