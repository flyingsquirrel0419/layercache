import { afterEach, vi } from 'vitest'

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
  const actual = await vi.importActual<Record<string, unknown>>('ioredis')
  const { default: MockRedis } = (await import('ioredis-mock')) as unknown as {
    default: new (...args: unknown[]) => object
  }

  const WrappedRedis = function wrappedRedis(this: unknown, ...args: unknown[]) {
    return trackRedisInstance(
      new MockRedis(...args) as { disconnect?: () => void; duplicate?: (...args: unknown[]) => unknown }
    )
  } as unknown as typeof MockRedis

  Object.setPrototypeOf(WrappedRedis, MockRedis)
  WrappedRedis.prototype = MockRedis.prototype

  return {
    ...actual,
    default: WrappedRedis,
    Redis: WrappedRedis
  }
})

afterEach(() => {
  for (const redis of redisInstances) {
    try {
      redis.disconnect?.()
    } catch {
      // Best-effort cleanup for shared mock redis contexts.
    }
  }

  redisInstances.clear()
})
