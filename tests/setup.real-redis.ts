import type RealRedis from 'ioredis'
import { afterAll, afterEach, beforeAll, vi } from 'vitest'

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379'
const POOL_ID = Number.parseInt(process.env.VITEST_POOL_ID ?? '1', 10) || 1
// Logical db 0 is reserved for tests/integration/redis/* (TEST_PREFIX-scoped, shared).
// Mirrored unit test files get a worker-private logical db in 1..15 instead.
const REDIS_DB = 1 + ((POOL_ID - 1) % 15)

const redisInstances = new Set<{ disconnect?: () => void; duplicate?: (...args: unknown[]) => unknown }>()

function trackRedisInstance<T extends { disconnect?: () => void; duplicate?: (...args: unknown[]) => unknown }>(
  instance: T
): T {
  if (redisInstances.has(instance)) {
    return instance
  }

  redisInstances.add(instance)

  if (typeof instance.duplicate === 'function') {
    const originalDuplicate = instance.duplicate.bind(instance)
    instance.duplicate = (...args: unknown[]) => {
      const duplicate = originalDuplicate(...args)
      return trackRedisInstance(duplicate as { disconnect?: () => void; duplicate?: (...args: unknown[]) => unknown })
    }
  }

  return instance
}

vi.mock('ioredis', async () => {
  const actual = await vi.importActual<{ default: typeof RealRedis }>('ioredis')
  const ActualRedis = actual.default

  // Tests construct clients with `new Redis()`; pin every client to the
  // worker-scoped logical db so parallel workers cannot see each other's keys.
  // ioredis auto-connects and buffers commands in its offline queue, matching
  // ioredis-mock's synchronously-ready behavior.
  const WrappedRedis = function wrappedRedis(this: unknown, ..._args: unknown[]) {
    return trackRedisInstance(new ActualRedis(REDIS_URL, { db: REDIS_DB }))
  } as unknown as typeof ActualRedis

  Object.setPrototypeOf(WrappedRedis, ActualRedis)
  WrappedRedis.prototype = ActualRedis.prototype

  return {
    ...actual,
    default: WrappedRedis,
    Redis: WrappedRedis
  }
})

let controlClient: RealRedis | null = null

beforeAll(async () => {
  if (process.env.REDIS_AVAILABLE !== '1') {
    throw new Error(
      'The real-redis mirror project needs a running Redis. Run `npm run test:integration` ' +
        '(starts docker compose) or set REDIS_AVAILABLE=1 and REDIS_URL.'
    )
  }

  const { default: ActualRedis } = await vi.importActual<{ default: typeof RealRedis }>('ioredis')
  controlClient = new ActualRedis(REDIS_URL, { db: REDIS_DB })
  // ioredis-mock gives each test file a fresh keyspace that is shared between
  // instances and persists across tests within the file. Mirror that exactly:
  // flush the worker db once per file, never per test.
  await controlClient.flushdb()
})

afterEach(() => {
  for (const redis of redisInstances) {
    try {
      redis.disconnect?.()
    } catch {
      // Best-effort cleanup, mirroring tests/setup.ts.
    }
  }

  redisInstances.clear()
})

afterAll(async () => {
  if (!controlClient) {
    return
  }

  try {
    await controlClient.flushdb()
  } catch {
    // Best-effort cleanup.
  }

  controlClient.disconnect()
  controlClient = null
})
