import Redis from 'ioredis-mock'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CacheStack } from '../../src/CacheStack'
import { MemoryLayer } from '../../src/layers/MemoryLayer'
import { RedisLayer } from '../../src/layers/RedisLayer'
import { RedisSingleFlightCoordinator } from '../../src/singleflight/RedisSingleFlightCoordinator'
import type {
  CacheLayer,
  CacheSingleFlightCoordinator,
  CacheSingleFlightExecutionOptions,
  InvalidationBus,
  InvalidationMessage
} from '../../src/types'

class FailingSetLayer implements CacheLayer {
  readonly name = 'failing'

  async get(): Promise<null> {
    return null
  }

  async set(): Promise<void> {
    throw new Error('set failed')
  }

  async delete(): Promise<void> {}

  async clear(): Promise<void> {}
}

class BulkLayer implements CacheLayer {
  readonly name = 'bulk'
  readonly values = new Map<string, unknown>()
  getManyCalls = 0

  async get<T>(key: string): Promise<T | null> {
    return (this.values.get(key) as T | undefined) ?? null
  }

  async getEntry<T = unknown>(key: string): Promise<T | null> {
    return (this.values.get(key) as T | undefined) ?? null
  }

  async getMany<T>(keys: string[]): Promise<Array<T | null>> {
    this.getManyCalls += 1
    return keys.map((key) => (this.values.get(key) as T | undefined) ?? null)
  }

  async set(key: string, value: unknown): Promise<void> {
    this.values.set(key, value)
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key)
  }

  async clear(): Promise<void> {
    this.values.clear()
  }
}

class SharedCoordinator implements CacheSingleFlightCoordinator {
  private readonly active = new Map<string, Promise<unknown>>()

  async execute<T>(
    key: string,
    _options: CacheSingleFlightExecutionOptions,
    worker: () => Promise<T>,
    waiter: () => Promise<T>
  ): Promise<T> {
    const active = this.active.get(key)
    if (active) {
      return waiter()
    }

    const task = worker().finally(() => {
      this.active.delete(key)
    })

    this.active.set(key, task)
    return task
  }
}

class InMemoryInvalidationBus implements InvalidationBus {
  private readonly handlers = new Set<(message: InvalidationMessage) => Promise<void> | void>()

  async subscribe(handler: (message: InvalidationMessage) => Promise<void> | void): Promise<() => void> {
    this.handlers.add(handler)
    return () => {
      this.handlers.delete(handler)
    }
  }

  async publish(message: InvalidationMessage): Promise<void> {
    await Promise.all([...this.handlers].map((handler) => handler(message)))
  }
}

describe('operational features', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('supports negative caching for null fetch results', async () => {
    const cache = new CacheStack([new MemoryLayer({ ttl: 60 })], {
      negativeCaching: true
    })
    let fetches = 0

    await expect(
      cache.get(
        'user:404',
        async () => {
          fetches += 1
          return null
        },
        { negativeTtl: 1 }
      )
    ).resolves.toBeNull()

    await expect(
      cache.get(
        'user:404',
        async () => {
          fetches += 1
          return { id: 404 }
        },
        { negativeTtl: 1 }
      )
    ).resolves.toBeNull()

    await new Promise((resolve) => setTimeout(resolve, 1_100))

    await expect(
      cache.get(
        'user:404',
        async () => {
          fetches += 1
          return { id: 404 }
        },
        { negativeTtl: 1 }
      )
    ).resolves.toEqual({ id: 404 })

    expect(fetches).toBe(2)
  })

  it('serves stale values while revalidating in the background', async () => {
    const cache = new CacheStack([new MemoryLayer({ ttl: 60 })])
    await cache.set('user:1', { version: 1 }, { ttl: 1, staleWhileRevalidate: 5 })
    await new Promise((resolve) => setTimeout(resolve, 1_100))

    let fetches = 0
    await expect(
      cache.get('user:1', async () => {
        fetches += 1
        await new Promise((resolve) => setTimeout(resolve, 25))
        return { version: 2 }
      })
    ).resolves.toEqual({ version: 1 })

    await new Promise((resolve) => setTimeout(resolve, 50))

    await expect(cache.get('user:1')).resolves.toEqual({ version: 2 })
    expect(fetches).toBe(1)
    expect(cache.getMetrics()).toMatchObject({
      staleHits: 1,
      refreshes: 1
    })
  })

  it('returns stale values when refresh fails inside stale-if-error window', async () => {
    const cache = new CacheStack([new MemoryLayer({ ttl: 60 })])
    await cache.set('settings', { version: 1 }, { ttl: 1, staleIfError: 5 })
    await new Promise((resolve) => setTimeout(resolve, 1_100))

    let attempts = 0
    await expect(
      cache.get('settings', async () => {
        attempts += 1
        throw new Error('upstream unavailable')
      })
    ).resolves.toEqual({ version: 1 })

    expect(attempts).toBe(1)
    expect(cache.getMetrics().refreshErrors).toBe(1)
  })

  it('applies ttl jitter before writing to layers', async () => {
    const layer = new BulkLayer()
    const cache = new CacheStack([layer])
    vi.spyOn(Math, 'random').mockReturnValue(1)

    await cache.set('jittered', { ok: true }, { ttl: 10, ttlJitter: 2 })

    const stored = await layer.getEntry?.<{
      freshUntil: number
    }>('jittered')

    expect(stored).not.toBeNull()
    if (stored && typeof stored === 'object' && 'freshUntil' in stored) {
      const ttlSeconds = Math.round(((stored.freshUntil as number) - Date.now()) / 1_000)
      expect(ttlSeconds).toBeGreaterThanOrEqual(11)
    }
  })

  it('can tolerate partial write failures in best-effort mode', async () => {
    const cache = new CacheStack([new MemoryLayer({ ttl: 60 }), new FailingSetLayer()], { writePolicy: 'best-effort' })

    await expect(cache.set('user:1', { id: 1 })).resolves.toBeUndefined()
    await expect(cache.get('user:1')).resolves.toEqual({ id: 1 })
    expect(cache.getMetrics().writeFailures).toBe(1)
  })

  it('uses layer bulk reads for simple mget calls', async () => {
    const layer = new BulkLayer()
    layer.values.set('a', 1)
    layer.values.set('b', 2)
    const cache = new CacheStack([layer])

    await expect(cache.mget([{ key: 'a' }, { key: 'b' }])).resolves.toEqual([1, 2])
    expect(layer.getManyCalls).toBe(1)
  })

  it('deduplicates duplicate keys during simple mget calls', async () => {
    const layer = new BulkLayer()
    layer.values.set('a', 1)
    layer.values.set('b', 2)
    const cache = new CacheStack([layer])

    await expect(cache.mget([{ key: 'a' }, { key: 'a' }, { key: 'b' }])).resolves.toEqual([1, 1, 2])
    expect(layer.getManyCalls).toBe(1)
  })

  it('rejects conflicting duplicate mget entries', async () => {
    const cache = new CacheStack([new MemoryLayer({ ttl: 60 })])

    await expect(
      cache.mget([
        { key: 'user:1', options: { ttl: 5 } },
        { key: 'user:1', options: { ttl: 10 } }
      ])
    ).rejects.toThrow(/conflicting entries/i)
  })

  it('does not schedule stale refreshes after disconnect begins', async () => {
    const cache = new CacheStack([new MemoryLayer({ ttl: 60 })])
    await cache.set('user:1', { version: 1 }, { ttl: 1, staleWhileRevalidate: 5 })
    await new Promise((resolve) => setTimeout(resolve, 1_100))

    let refreshes = 0
    const disconnectPromise = cache.disconnect()

    await expect(
      cache.get('user:1', async () => {
        refreshes += 1
        return { version: 2 }
      })
    ).resolves.toEqual({ version: 1 })

    await disconnectPromise
    await new Promise((resolve) => setTimeout(resolve, 25))

    expect(refreshes).toBe(0)
  })

  it('validates cache keys and runtime ttl options', async () => {
    const cache = new CacheStack([new MemoryLayer({ ttl: 60 })])

    await expect(cache.get('')).rejects.toThrow(/must not be empty/i)
    await expect(cache.set('user:1', { id: 1 }, { negativeTtl: -1 })).rejects.toThrow(/non-negative finite/i)
  })

  it('validates conflicting constructor options eagerly', () => {
    const coordinator = new SharedCoordinator()

    expect(
      () =>
        new CacheStack([new MemoryLayer({ ttl: 60 })], {
          stampedePrevention: false,
          singleFlightCoordinator: coordinator
        })
    ).toThrow(/requires stampedePrevention/i)

    expect(
      () =>
        new CacheStack([new MemoryLayer({ ttl: 60 })], {
          negativeTtl: -1
        })
    ).toThrow(/non-negative finite/i)
  })

  it('supports broadcastL1Invalidation as an alias for write-triggered invalidation', async () => {
    const redis = new Redis()
    const memoryB = new MemoryLayer({ ttl: 60 })
    const invalidationBus = new InMemoryInvalidationBus()
    const cacheA = new CacheStack(
      [new MemoryLayer({ ttl: 60 }), new RedisLayer({ client: redis, ttl: 300, prefix: 'cache:alias:' })],
      { invalidationBus, broadcastL1Invalidation: false }
    )
    const cacheB = new CacheStack([memoryB, new RedisLayer({ client: redis, ttl: 300, prefix: 'cache:alias:' })], {
      invalidationBus
    })

    await cacheA.set('user:1', { id: 1, version: 1 })
    await cacheB.get('user:1')
    await cacheA.set('user:1', { id: 1, version: 2 })

    await expect(memoryB.get('user:1')).resolves.toEqual({ id: 1, version: 1 })

    await Promise.all([cacheA.disconnect(), cacheB.disconnect()])
  })

  it('deduplicates fetches across cache instances when a shared coordinator is configured', async () => {
    const redis = new Redis()
    const coordinator = new SharedCoordinator()
    const cacheA = new CacheStack(
      [new MemoryLayer({ ttl: 60 }), new RedisLayer({ client: redis, ttl: 60, prefix: 'cache:coordinator:' })],
      { singleFlightCoordinator: coordinator }
    )
    const cacheB = new CacheStack(
      [new MemoryLayer({ ttl: 60 }), new RedisLayer({ client: redis, ttl: 60, prefix: 'cache:coordinator:' })],
      { singleFlightCoordinator: coordinator }
    )

    let fetches = 0
    const fetchUser = async () => {
      fetches += 1
      await new Promise((resolve) => setTimeout(resolve, 25))
      return { id: 1 }
    }

    await expect(Promise.all([cacheA.get('user:1', fetchUser), cacheB.get('user:1', fetchUser)])).resolves.toEqual([
      { id: 1 },
      { id: 1 }
    ])

    expect(fetches).toBe(1)
    expect(cacheB.getMetrics().singleFlightWaits).toBe(1)
  })

  it('provides a redis-backed distributed single-flight coordinator', async () => {
    const redis = new Redis()
    const coordinator = new RedisSingleFlightCoordinator({ client: redis, prefix: 'sf:test' })

    let fetches = 0
    const [first, second] = await Promise.all([
      coordinator.execute(
        'user:1',
        { leaseMs: 1_000, waitTimeoutMs: 100, pollIntervalMs: 10 },
        async () => {
          fetches += 1
          await new Promise((resolve) => setTimeout(resolve, 25))
          return 'value'
        },
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 30))
          return 'value'
        }
      ),
      coordinator.execute(
        'user:1',
        { leaseMs: 1_000, waitTimeoutMs: 100, pollIntervalMs: 10 },
        async () => {
          fetches += 1
          return 'value'
        },
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 30))
          return 'value'
        }
      )
    ])

    expect(first).toBe('value')
    expect(second).toBe('value')
    expect(fetches).toBe(1)
  })
})
