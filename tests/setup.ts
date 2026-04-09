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

vi.mock('ioredis-mock', async () => {
  const actual = await vi.importActual<{ default: new (...args: unknown[]) => object }>('ioredis-mock')
  const OriginalRedis = actual.default

  const WrappedRedis = function wrappedRedis(this: unknown, ...args: unknown[]) {
    return trackRedisInstance(
      new OriginalRedis(...args) as { disconnect?: () => void; duplicate?: (...args: unknown[]) => unknown }
    )
  } as unknown as typeof OriginalRedis

  Object.setPrototypeOf(WrappedRedis, OriginalRedis)
  WrappedRedis.prototype = OriginalRedis.prototype

  return {
    ...actual,
    default: WrappedRedis
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
