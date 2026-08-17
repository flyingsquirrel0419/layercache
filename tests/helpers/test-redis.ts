import Redis from 'ioredis'
import RedisMock from 'ioredis-mock'
import { describe, inject, it } from 'vitest'
import { DEFAULT_REDIS_PORT } from './redis-config'

export const REDIS_URL = process.env.REDIS_URL ?? inject('redisUrl') ?? `redis://localhost:${DEFAULT_REDIS_PORT}`

const POOL_ID = Number.parseInt(process.env.VITEST_POOL_ID ?? '1', 10) || 1
// Real-redis suites (redis-integration + real-redis-mirror) pin each worker to a
// private logical db in 1..15 so parallel workers cannot see each other's keys.
export const REAL_REDIS_DB = 1 + ((POOL_ID - 1) % 15)

const useRealRedis = process.env.LAYERCACHE_TEST_REDIS === 'real'

/** True when the suite runs against a live Redis (integration / real-redis-mirror). */
export const isRealRedis = useRealRedis

/** describe/it wrappers that skip unless LAYERCACHE_TEST_REDIS=real. */
export const realRedisTest = {
  describe: describe.skipIf(!isRealRedis) as typeof describe,
  it: it.skipIf(!isRealRedis) as typeof it
}

const instances = new Set<Redis>()

function track(instance: Redis): Redis {
  if (instances.has(instance)) {
    return instance
  }

  instances.add(instance)

  if (typeof instance.duplicate === 'function') {
    const originalDuplicate = instance.duplicate.bind(instance)
    instance.duplicate = (...args) => {
      const duplicate = originalDuplicate(...args)
      return track(duplicate)
    }
  }

  return instance
}

/**
 * Creates a Redis client for tests. Unit runs get ioredis-mock (per-file shared
 * in-memory keyspace); the real-redis-mirror vitest project sets
 * LAYERCACHE_TEST_REDIS=real and gets a real client pinned to a worker-scoped
 * logical db so parallel workers cannot see each other's keys. Every instance
 * (including clients created via duplicate()) is tracked for cleanup.
 */
export function createTestRedis(): Redis {
  if (useRealRedis) {
    return track(new Redis(REDIS_URL, { db: REAL_REDIS_DB }))
  }

  return track(new RedisMock())
}

/** Untracked real client for setup-file flushdb; the caller owns its lifecycle. */
export function createRealControlClient(): Redis {
  return new Redis(REDIS_URL, { db: REAL_REDIS_DB })
}

/** Disconnects and forgets every client created via createTestRedis(). */
export function disconnectAllTestRedis(): void {
  for (const redis of instances) {
    try {
      redis.disconnect?.()
    } catch {
      // Best-effort cleanup for shared mock redis contexts.
    }
  }

  instances.clear()
}
