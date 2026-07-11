import Redis from 'ioredis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CacheStack } from '../../src/CacheStack'
import * as TtlResolverModule from '../../src/internal/TtlResolver'
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
  setManyCalls = 0

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

  async setMany(entries: Array<{ key: string; value: unknown }>): Promise<void> {
    this.setManyCalls += 1
    for (const entry of entries) {
      this.values.set(entry.key, entry.value)
    }
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

class WaitThenWorkerCoordinator implements CacheSingleFlightCoordinator {
  calls = 0

  async execute<T>(
    _key: string,
    _options: CacheSingleFlightExecutionOptions,
    worker: () => Promise<T>,
    waiter: () => Promise<T>
  ): Promise<T> {
    this.calls += 1
    return this.calls === 1 ? waiter() : worker()
  }
}

class ThrowingCoordinator implements CacheSingleFlightCoordinator {
  constructor(private readonly error: Error) {}

  async execute<T>(
    _key: string,
    _options: CacheSingleFlightExecutionOptions,
    _worker: () => Promise<T>,
    _waiter: () => Promise<T>
  ): Promise<T> {
    throw this.error
  }
}

class ImmediateWorkerCoordinator implements CacheSingleFlightCoordinator {
  async execute<T>(
    _key: string,
    _options: CacheSingleFlightExecutionOptions,
    worker: () => Promise<T>,
    _waiter: () => Promise<T>
  ): Promise<T> {
    return worker()
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

async function waitForCondition(
  assertion: () => Promise<void> | void,
  timeoutMs = 1_000,
  pollIntervalMs = 10
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown

  while (Date.now() < deadline) {
    try {
      await assertion()
      return
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs))
    }
  }

  if (lastError instanceof Error) {
    throw lastError
  }

  throw new Error('timed out waiting for condition')
}

describe('operational features', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('supports negative caching for null fetch results', async () => {
    const cache = new CacheStack([new MemoryLayer({ ttl: 60_000 })], {
      negativeCaching: true,
      cacheNullValues: false
    })
    let fetches = 0

    await expect(
      cache.get(
        'user:404',
        async () => {
          fetches += 1
          return null
        },
        { negativeTtl: 1_000 }
      )
    ).resolves.toBeUndefined()

    await expect(
      cache.get(
        'user:404',
        async () => {
          fetches += 1
          return { id: 404 }
        },
        { negativeTtl: 1_000 }
      )
    ).resolves.toBeUndefined()

    await new Promise((resolve) => setTimeout(resolve, 1_100))

    await expect(
      cache.get(
        'user:404',
        async () => {
          fetches += 1
          return { id: 404 }
        },
        { negativeTtl: 1_000 }
      )
    ).resolves.toEqual({ id: 404 })

    expect(fetches).toBe(2)
  })

  it('serves stale values while revalidating in the background', async () => {
    const cache = new CacheStack([new MemoryLayer({ ttl: 60_000 })])
    await cache.set('user:1', { version: 1 }, { ttl: 1_000, staleWhileRevalidate: 5_000 })
    await new Promise((resolve) => setTimeout(resolve, 1_100))

    let fetches = 0
    await expect(
      cache.get('user:1', async () => {
        fetches += 1
        await new Promise((resolve) => setTimeout(resolve, 25))
        return { version: 2 }
      })
    ).resolves.toEqual({ version: 1 })

    await waitForCondition(async () => {
      expect(cache.getStats().backgroundRefreshes).toBe(0)
    })

    await expect(cache.get('user:1')).resolves.toEqual({ version: 2 })
    expect(fetches).toBe(1)
    expect(cache.getMetrics()).toMatchObject({
      staleHits: 1,
      refreshes: 1
    })
  })

  it('keeps hung background refreshes deduplicated after observer timeout', async () => {
    const cache = new CacheStack([new MemoryLayer({ ttl: 60_000 })], {
      backgroundRefreshTimeoutMs: 20
    })
    await cache.set('user:1', { version: 1 }, { ttl: 1_000, staleWhileRevalidate: 5_000 })
    await new Promise((resolve) => setTimeout(resolve, 1_100))

    const fetcher = vi.fn(
      async () =>
        await new Promise<{ version: number }>(() => {
          // intentionally hangs
        })
    )

    await expect(cache.get('user:1', fetcher)).resolves.toEqual({ version: 1 })
    expect(cache.getStats().backgroundRefreshes).toBe(1)

    await waitForCondition(async () => {
      expect(cache.getMetrics().refreshErrors).toBe(1)
    })

    expect(cache.getStats().backgroundRefreshes).toBe(1)
    expect(cache.getMetrics().refreshErrors).toBe(1)

    await expect(cache.get('user:1', fetcher)).resolves.toEqual({ version: 1 })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('does not leak late background refresh rejections after a timeout', async () => {
    const cache = new CacheStack([new MemoryLayer({ ttl: 60_000 })], {
      backgroundRefreshTimeoutMs: 20
    })
    await cache.set('user:1', { version: 1 }, { ttl: 1_000, staleWhileRevalidate: 5_000 })
    await new Promise((resolve) => setTimeout(resolve, 1_100))

    let rejectFetch!: (reason?: unknown) => void
    const fetcher = vi.fn(
      () =>
        new Promise<{ version: number }>((_, reject) => {
          rejectFetch = reject
        })
    )
    const unhandled = vi.fn()
    const listener = (reason: unknown) => {
      unhandled(reason)
    }
    process.on('unhandledRejection', listener)

    try {
      await expect(cache.get('user:1', fetcher)).resolves.toEqual({ version: 1 })
      await waitForCondition(async () => {
        expect(cache.getMetrics().refreshErrors).toBe(1)
      })
      expect(cache.getStats().backgroundRefreshes).toBe(1)

      rejectFetch(new Error('late failure'))
      await waitForCondition(async () => {
        expect(cache.getStats().backgroundRefreshes).toBe(0)
      })

      expect(unhandled).not.toHaveBeenCalled()
      expect(cache.getStats().backgroundRefreshes).toBe(0)
    } finally {
      process.off('unhandledRejection', listener)
    }
  })

  it('does not repopulate cleared keys from in-flight background refreshes', async () => {
    const cache = new CacheStack([new MemoryLayer({ ttl: 60_000 })])
    await cache.set('user:1', { version: 1 }, { ttl: 1_000, staleWhileRevalidate: 5_000 })
    await new Promise((resolve) => setTimeout(resolve, 1_100))

    let releaseFetch!: () => void
    const fetcher = vi.fn(
      () =>
        new Promise<{ version: number }>((resolve) => {
          releaseFetch = () => resolve({ version: 2 })
        })
    )

    await expect(cache.get('user:1', fetcher)).resolves.toEqual({ version: 1 })
    await cache.clear()
    releaseFetch()
    await waitForCondition(async () => {
      await expect(cache.get('user:1')).resolves.toBeUndefined()
    })

    await expect(cache.get('user:1')).resolves.toBeUndefined()
  })

  it('does not repopulate deleted keys from in-flight background refreshes', async () => {
    const cache = new CacheStack([new MemoryLayer({ ttl: 60_000 })])
    await cache.set('user:1', { version: 1 }, { ttl: 1_000, staleWhileRevalidate: 5_000 })
    await new Promise((resolve) => setTimeout(resolve, 1_100))

    let releaseFetch!: () => void
    const fetcher = vi.fn(
      () =>
        new Promise<{ version: number }>((resolve) => {
          releaseFetch = () => resolve({ version: 2 })
        })
    )

    await expect(cache.get('user:1', fetcher)).resolves.toEqual({ version: 1 })
    await cache.delete('user:1')
    releaseFetch()
    await waitForCondition(async () => {
      await expect(cache.get('user:1')).resolves.toBeUndefined()
    })

    await expect(cache.get('user:1')).resolves.toBeUndefined()
  })

  it('does not repopulate deleted keys with negative-cache markers after refresh completes', async () => {
    const cache = new CacheStack([new MemoryLayer({ ttl: 60_000 })], {
      negativeCaching: true
    })
    await cache.set('user:1', { version: 1 }, { ttl: 1_000, staleWhileRevalidate: 5_000 })
    await new Promise((resolve) => setTimeout(resolve, 1_100))

    let releaseFetch!: () => void
    const fetcher = vi.fn(
      () =>
        new Promise<null>((resolve) => {
          releaseFetch = () => resolve(null)
        })
    )

    await expect(cache.get('user:1', fetcher)).resolves.toEqual({ version: 1 })
    await cache.delete('user:1')
    releaseFetch()
    await waitForCondition(async () => {
      await expect(cache.get('user:1')).resolves.toBeUndefined()
    })

    await expect(cache.get('user:1')).resolves.toBeUndefined()
    expect(cache.getMetrics().negativeCacheHits).toBe(0)
  })

  it('returns stale values when refresh fails inside stale-if-error window', async () => {
    const cache = new CacheStack([new MemoryLayer({ ttl: 60_000 })])
    await cache.set('settings', { version: 1 }, { ttl: 1_000, staleIfError: 5_000 })
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

  it('serves stale-if-error values without requiring a fetcher', async () => {
    const cache = new CacheStack([new MemoryLayer({ ttl: 60_000 })])
    await cache.set('settings', { version: 1 }, { ttl: 1_000, staleIfError: 5_000 })
    await new Promise((resolve) => setTimeout(resolve, 1_100))

    await expect(cache.get('settings')).resolves.toEqual({ version: 1 })
    expect(cache.getMetrics()).toMatchObject({
      hits: 1,
      staleHits: 1,
      refreshErrors: 0
    })
  })

  it('applies ttl jitter before writing to layers', async () => {
    const layer = new BulkLayer()
    const cache = new CacheStack([layer])
    vi.spyOn(TtlResolverModule.secureRandom, 'value').mockReturnValue(1)

    await cache.set('jittered', { ok: true }, { ttl: 10_000, ttlJitter: 2_000 })

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
    const cache = new CacheStack([new MemoryLayer({ ttl: 60_000 }), new FailingSetLayer()], {
      writePolicy: 'best-effort'
    })

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
    const cache = new CacheStack([new MemoryLayer({ ttl: 60_000 })])

    await expect(
      cache.mget([
        { key: 'user:1', options: { ttl: 5_000 } },
        { key: 'user:1', options: { ttl: 10_000 } }
      ])
    ).rejects.toThrow(/conflicting entries/i)
  })

  it('does not schedule stale refreshes after disconnect begins', async () => {
    const cache = new CacheStack([new MemoryLayer({ ttl: 60_000 })])
    await cache.set('user:1', { version: 1 }, { ttl: 1_000, staleWhileRevalidate: 5_000 })
    await new Promise((resolve) => setTimeout(resolve, 1_100))

    let refreshes = 0
    const disconnectPromise = cache.disconnect()

    await expect(
      cache.get('user:1', async () => {
        refreshes += 1
        return { version: 2 }
      })
    ).rejects.toThrow(/disconnecting/i)

    await disconnectPromise

    expect(refreshes).toBe(0)
  })

  it('does not schedule a second background refresh while one is already in flight', async () => {
    const cache = new CacheStack([new MemoryLayer({ ttl: 60_000 })], {
      backgroundRefreshTimeoutMs: 20
    })
    await cache.set('user:1', { version: 1 }, { ttl: 1_000, staleWhileRevalidate: 5_000 })
    await new Promise((resolve) => setTimeout(resolve, 1_100))

    const fetcher = vi.fn(
      async () =>
        await new Promise<{ version: number }>(() => {
          // intentionally hangs until the timeout guard trips
        })
    )

    await expect(cache.get('user:1', fetcher)).resolves.toEqual({ version: 1 })
    await expect(cache.get('user:1', fetcher)).resolves.toEqual({ version: 1 })

    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(cache.getStats().backgroundRefreshes).toBe(1)

    await waitForCondition(async () => {
      expect(cache.getMetrics().refreshErrors).toBe(1)
    })
    expect(cache.getStats().backgroundRefreshes).toBe(1)
  })

  it('uses layer bulk writes for mset when available', async () => {
    const layer = new BulkLayer()
    const cache = new CacheStack([layer])

    await cache.mset([
      { key: 'a', value: 1 },
      { key: 'b', value: 2 }
    ])

    expect(layer.setManyCalls).toBe(1)
    await expect(cache.mget([{ key: 'a' }, { key: 'b' }])).resolves.toEqual([1, 2])
  })

  it('supports write-behind for remote layers', async () => {
    const memory = new MemoryLayer({ ttl: 60_000 })
    const remote = new BulkLayer()
    ;(remote as { isLocal?: boolean }).isLocal = false
    const cache = new CacheStack([memory, remote], {
      writeStrategy: 'write-behind',
      writeBehind: { batchSize: 1 }
    })

    await cache.set('user:1', { id: 1 })

    await expect(memory.get('user:1')).resolves.toEqual({ id: 1 })
    await cache.disconnect()
    await expect(remote.get('user:1')).resolves.toEqual(
      expect.objectContaining({
        __layercache: 1
      })
    )
  })

  it('does not let queued write-behind operations repopulate keys after clear', async () => {
    const memory = new MemoryLayer({ ttl: 60_000 })
    const remote = new BulkLayer()
    ;(remote as { isLocal?: boolean }).isLocal = false
    const cache = new CacheStack([memory, remote], {
      writeStrategy: 'write-behind',
      writeBehind: { batchSize: 10, flushIntervalMs: 1_000 }
    })

    await cache.set('user:1', { id: 1 })
    await cache.clear()
    await cache.disconnect()

    await expect(remote.get('user:1')).resolves.toBeNull()
  })

  it('rate-limits fetchers when configured', async () => {
    const cache = new CacheStack([new MemoryLayer({ ttl: 60_000 })])
    let concurrent = 0
    let maxConcurrent = 0

    await Promise.all(
      ['a', 'b', 'c'].map((key) =>
        cache.get(
          key,
          async () => {
            concurrent += 1
            maxConcurrent = Math.max(maxConcurrent, concurrent)
            await new Promise((resolve) => setTimeout(resolve, 25))
            concurrent -= 1
            return key
          },
          { fetcherRateLimit: { maxConcurrent: 1 } }
        )
      )
    )

    expect(maxConcurrent).toBe(1)
  })

  it('can rate-limit fetchers per cache key instead of globally', async () => {
    const cache = new CacheStack([new MemoryLayer({ ttl: 60_000 })])
    let concurrent = 0
    let maxConcurrent = 0

    await Promise.all(
      ['a', 'b', 'c'].map((key) =>
        cache.get(
          key,
          async () => {
            concurrent += 1
            maxConcurrent = Math.max(maxConcurrent, concurrent)
            await new Promise((resolve) => setTimeout(resolve, 25))
            concurrent -= 1
            return key
          },
          { fetcherRateLimit: { maxConcurrent: 1, scope: 'key' } }
        )
      )
    )

    expect(maxConcurrent).toBeGreaterThan(1)
  })

  it('returns the fetched value but does not cache it when shouldCache throws', async () => {
    const warn = vi.fn()
    const cache = new CacheStack([new MemoryLayer({ ttl: 60_000 })], {
      logger: { warn }
    })

    await expect(
      cache.get('user:1', async () => ({ id: 1 }), {
        shouldCache: () => {
          throw new Error('bad predicate')
        }
      })
    ).resolves.toEqual({ id: 1 })

    await expect(cache.get('user:1')).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalled()
  })

  it('returns fetched values without caching them when shouldCache returns false', async () => {
    const cache = new CacheStack([new MemoryLayer({ ttl: 60_000 })])

    await expect(
      cache.get('user:1', async () => ({ id: 1, cacheable: false }), {
        shouldCache: () => false
      })
    ).resolves.toEqual({ id: 1, cacheable: false })

    await expect(cache.get('user:1')).resolves.toBeUndefined()
  })

  it('supports context-aware entry options for fetched values', async () => {
    const cache = new CacheStack([new MemoryLayer({ ttl: 60_000 })])

    await expect(
      cache.get(
        'oauth:token',
        async () => ({
          accessToken: 'a',
          refreshTtlMs: 2_000,
          tenant: 'acme'
        }),
        {
          ttl: 60_000,
          tags: ['fallback'],
          contextOptions: ({ value }) => {
            const token = value as { refreshTtlMs: number; tenant: string }
            return {
              ttl: token.refreshTtlMs,
              tags: ['oauth', `tenant:${token.tenant}`]
            }
          }
        }
      )
    ).resolves.toEqual({
      accessToken: 'a',
      refreshTtlMs: 2_000,
      tenant: 'acme'
    })

    await expect(cache.inspect('oauth:token')).resolves.toEqual(
      expect.objectContaining({
        tags: ['oauth', 'tenant:acme'],
        freshTtlMs: expect.any(Number)
      })
    )
  })

  it('supports context-aware entry options for direct set operations', async () => {
    const cache = new CacheStack([new MemoryLayer({ ttl: 60_000 })])

    await cache.set(
      'report:daily',
      { scope: 'daily', expiresInMs: 1_000 },
      {
        ttl: 60_000,
        contextOptions: ({ value }) => ({
          ttl: (value as { expiresInMs: number }).expiresInMs
        })
      }
    )

    await new Promise((resolve) => setTimeout(resolve, 1_100))

    await expect(cache.get('report:daily')).resolves.toBeUndefined()
  })

  it('falls back to static entry options when context-aware overrides are omitted', async () => {
    const cache = new CacheStack([new MemoryLayer({ ttl: 60_000 })])

    await cache.set(
      'report:weekly',
      { expiresInMs: 10_000 },
      {
        ttl: 1_000,
        tags: ['reports'],
        contextOptions: () => undefined
      }
    )

    await expect(cache.inspect('report:weekly')).resolves.toEqual(
      expect.objectContaining({
        tags: ['reports'],
        freshTtlMs: expect.any(Number)
      })
    )
  })

  it('surfaces invalid context-aware entry options clearly', async () => {
    const cache = new CacheStack([new MemoryLayer({ ttl: 60_000 })])

    await expect(
      cache.get('broken:entry', async () => ({ ttl: -1 }), {
        contextOptions: () => ({ ttl: -1 })
      })
    ).rejects.toThrow(/contextOptions\(\) returned invalid entry options/i)
  })

  it('surfaces context-aware resolver failures clearly', async () => {
    const cache = new CacheStack([new MemoryLayer({ ttl: 60_000 })])

    await expect(
      cache.get('broken:resolver', async () => ({ ok: true }), {
        contextOptions: () => {
          throw new Error('resolver exploded')
        }
      })
    ).rejects.toThrow(/contextOptions\(\) failed for key "broken:resolver"/i)
  })

  it('rejects non-object context-aware resolver results clearly', async () => {
    const cache = new CacheStack([new MemoryLayer({ ttl: 60_000 })])

    await expect(
      cache.get('broken:primitive', async () => ({ ok: true }), {
        contextOptions: () => 123 as never
      })
    ).rejects.toThrow(/must return a plain object or undefined/i)

    await expect(
      cache.get('broken:array', async () => ({ ok: true }), {
        contextOptions: () => ['bad'] as never
      })
    ).rejects.toThrow(/must return a plain object or undefined/i)
  })

  it('rejects async context-aware resolvers clearly', async () => {
    const cache = new CacheStack([new MemoryLayer({ ttl: 60_000 })])

    await expect(
      cache.get('broken:async', async () => ({ ok: true }), {
        contextOptions: (async () => ({ ttl: 1 })) as never
      })
    ).rejects.toThrow(/async resolvers are not supported/i)
  })

  it('can treat null fetch results as uncached misses when explicitly disabled', async () => {
    const cache = new CacheStack([new MemoryLayer({ ttl: 60_000 })])
    const fetcher = vi.fn(async () => null)

    await expect(cache.get('user:404', fetcher, { cacheNullValues: false })).resolves.toBeUndefined()
    await expect(cache.get('user:404', fetcher, { cacheNullValues: false })).resolves.toBeUndefined()

    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('validates cache keys and runtime ttl options', async () => {
    const cache = new CacheStack([new MemoryLayer({ ttl: 60_000 })])

    await expect(cache.get('')).rejects.toThrow(/must not be empty/i)
    await expect(cache.set('user:1', { id: 1 }, { negativeTtl: -1 })).rejects.toThrow(/non-negative finite/i)
    await expect(cache.set('user:1', { id: 1 }, { contextOptions: 'nope' as never })).rejects.toThrow(
      /contextOptions must be a function/i
    )
  })

  it('validates conflicting constructor options eagerly', () => {
    const coordinator = new SharedCoordinator()

    expect(
      () =>
        new CacheStack([new MemoryLayer({ ttl: 60_000 })], {
          stampedePrevention: false,
          singleFlightCoordinator: coordinator
        })
    ).toThrow(/requires stampedePrevention/i)

    expect(
      () =>
        new CacheStack([new MemoryLayer({ ttl: 60_000 })], {
          negativeTtl: -1
        })
    ).toThrow(/non-negative finite/i)
  })

  it('supports broadcastL1Invalidation as an alias for write-triggered invalidation', async () => {
    const redis = new Redis()
    const memoryB = new MemoryLayer({ ttl: 60_000 })
    const invalidationBus = new InMemoryInvalidationBus()
    const cacheA = new CacheStack(
      [new MemoryLayer({ ttl: 60_000 }), new RedisLayer({ client: redis, ttl: 300_000, prefix: 'cache:alias:' })],
      { invalidationBus, broadcastL1Invalidation: false }
    )
    const cacheB = new CacheStack([memoryB, new RedisLayer({ client: redis, ttl: 300_000, prefix: 'cache:alias:' })], {
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
      [new MemoryLayer({ ttl: 60_000 }), new RedisLayer({ client: redis, ttl: 60_000, prefix: 'cache:coordinator:' })],
      { singleFlightCoordinator: coordinator }
    )
    const cacheB = new CacheStack(
      [new MemoryLayer({ ttl: 60_000 }), new RedisLayer({ client: redis, ttl: 60_000, prefix: 'cache:coordinator:' })],
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

  it('rechecks the cache before fetching when a value appears between read passes', async () => {
    let reads = 0
    const layer: CacheLayer = {
      name: 'flip-read',
      get: async () => {
        reads += 1
        if (reads === 1) {
          return null
        }
        return 'late-hit'
      },
      set: async () => undefined,
      delete: async () => undefined,
      clear: async () => undefined
    }
    const cache = new CacheStack([layer])
    const fetcher = vi.fn(async () => 'fetched')

    await expect(cache.get('user:1', fetcher)).resolves.toBe('late-hit')

    expect(fetcher).not.toHaveBeenCalled()
    expect(reads).toBeGreaterThanOrEqual(2)
  })

  it('falls back to fetching after single-flight waiting times out', async () => {
    const fetcher = vi.fn(async () => 'fresh')
    const coordinator = new WaitThenWorkerCoordinator()
    const cache = new CacheStack([new MemoryLayer({ ttl: 60_000 })], {
      singleFlightCoordinator: coordinator,
      singleFlightTimeoutMs: 20,
      singleFlightPollMs: 5
    })

    await expect(cache.get('user:1', fetcher)).resolves.toBe('fresh')

    expect(coordinator.calls).toBe(2)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(cache.getMetrics().singleFlightWaits).toBe(1)
  })

  it('falls back to local fetching when the single-flight coordinator fails and graceful degradation is enabled', async () => {
    const fetcher = vi.fn(async () => 'fresh')
    const cache = new CacheStack([new MemoryLayer({ ttl: 60_000 })], {
      gracefulDegradation: true,
      singleFlightCoordinator: new ThrowingCoordinator(new Error('coordinator offline'))
    })

    await expect(cache.get('user:1', fetcher)).resolves.toBe('fresh')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('surfaces single-flight coordinator failures when graceful degradation is disabled', async () => {
    const fetcher = vi.fn(async () => 'fresh')
    const cache = new CacheStack([new MemoryLayer({ ttl: 60_000 })], {
      singleFlightCoordinator: new ThrowingCoordinator(new Error('coordinator offline'))
    })

    await expect(cache.get('user:1', fetcher)).rejects.toThrow(/coordinator offline/i)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('skips the second cache read on a coordinator-backed cold miss when the worker already owns the fetch', async () => {
    let reads = 0
    const layer: CacheLayer = {
      name: 'single-pass-read',
      get: async () => {
        reads += 1
        return null
      },
      set: async () => undefined,
      delete: async () => undefined,
      clear: async () => undefined
    }
    const fetcher = vi.fn(async () => 'fetched')
    const cache = new CacheStack([layer], {
      singleFlightCoordinator: new ImmediateWorkerCoordinator()
    })

    await expect(cache.get('user:1', fetcher)).resolves.toBe('fetched')

    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(reads).toBe(1)
  })

  it('preserves local single-flight collapse for concurrent misses when a coordinator is configured', async () => {
    const fetcher = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
      return 'fetched'
    })
    const cache = new CacheStack([new MemoryLayer({ ttl: 60_000 })], {
      singleFlightCoordinator: new ImmediateWorkerCoordinator()
    })

    const results = await Promise.all(Array.from({ length: 25 }, () => cache.get('user:1', fetcher)))

    expect(results.every((value) => value === 'fetched')).toBe(true)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('allows duplicate concurrent fetches when stampede prevention is disabled', async () => {
    let started = 0
    let releaseFirstFetch!: () => void
    let releaseSecondFetch!: () => void
    const firstFetchStarted = new Promise<void>((resolve) => {
      releaseFirstFetch = resolve
    })
    const secondFetchStarted = new Promise<void>((resolve) => {
      releaseSecondFetch = resolve
    })
    const bothFetchesStarted = Promise.all([firstFetchStarted, secondFetchStarted])
    let concurrentFetchTimeoutId: ReturnType<typeof setTimeout> | undefined
    const concurrentFetchTimeout = new Promise<void>((_, reject) => {
      concurrentFetchTimeoutId = setTimeout(
        () => reject(new Error('expected the second concurrent fetch to start when stampede prevention is disabled')),
        250
      )
    })
    const fetcher = vi.fn(async () => {
      started += 1
      if (started === 1) {
        releaseFirstFetch()
      }
      if (started === 2) {
        releaseSecondFetch()
      }

      await Promise.race([
        bothFetchesStarted.finally(() => {
          if (concurrentFetchTimeoutId) {
            clearTimeout(concurrentFetchTimeoutId)
          }
        }),
        concurrentFetchTimeout
      ])
      return { id: 1 }
    })
    const cache = new CacheStack([new MemoryLayer({ ttl: 60_000 })], {
      stampedePrevention: false
    })

    await expect(Promise.all([cache.get('user:1', fetcher), cache.get('user:1', fetcher)])).resolves.toEqual([
      { id: 1 },
      { id: 1 }
    ])

    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('formats primitive refresh failures without masking stale responses', async () => {
    const debug = vi.fn()
    const cache = new CacheStack([new MemoryLayer({ ttl: 60_000 })], {
      logger: { debug }
    })
    await cache.set('settings', 'cached', { ttl: 1_000, staleIfError: 5_000 })
    await new Promise((resolve) => setTimeout(resolve, 1_100))

    await expect(
      cache.get('settings', async () => {
        throw 'primitive failure'
      })
    ).resolves.toBe('cached')

    expect(debug).toHaveBeenCalledWith(
      'stale-if-error',
      expect.objectContaining({ key: 'settings', error: 'primitive failure' })
    )
  })

  it('refreshes stale primitive values through the timeout guard', async () => {
    const cache = new CacheStack([new MemoryLayer({ ttl: 60_000 })], {
      backgroundRefreshTimeoutMs: 50
    })
    await cache.set('greeting', 'hello-v1', { ttl: 1_000, staleWhileRevalidate: 5_000 })
    await new Promise((resolve) => setTimeout(resolve, 1_100))

    await expect(cache.get('greeting', async () => 'hello-v2')).resolves.toBe('hello-v1')
    await waitForCondition(async () => {
      await expect(cache.get('greeting')).resolves.toBe('hello-v2')
    })
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

  it('renews redis single-flight leases for long-running workers', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-08T00:00:00Z'))

    try {
      const redis = new Redis()
      const coordinator = new RedisSingleFlightCoordinator({ client: redis, prefix: 'sf:renew' })
      let fetches = 0
      let releaseFirst!: () => void
      const firstReleased = new Promise<void>((resolve) => {
        releaseFirst = resolve
      })

      const first = coordinator.execute(
        'user:renew',
        { leaseMs: 40, renewIntervalMs: 10, waitTimeoutMs: 200, pollIntervalMs: 10 },
        async () => {
          fetches += 1
          await firstReleased
          return 'value'
        },
        async () => 'waited'
      )

      await Promise.resolve()
      await vi.advanceTimersByTimeAsync(60)

      const second = coordinator.execute(
        'user:renew',
        { leaseMs: 40, renewIntervalMs: 10, waitTimeoutMs: 200, pollIntervalMs: 10 },
        async () => {
          fetches += 1
          return 'duplicate'
        },
        async () => 'value'
      )

      releaseFirst()

      await expect(Promise.all([first, second])).resolves.toEqual(['value', 'value'])
      expect(fetches).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('falls back to the waiter when a redis single-flight lock is already held', async () => {
    const redis = new Redis()
    const coordinator = new RedisSingleFlightCoordinator({ client: redis })
    const waiter = vi.fn(async () => 'waited')

    await redis.set('layercache:singleflight:user%3A1', 'held', 'PX', 1_000)

    await expect(
      coordinator.execute(
        'user:1',
        { leaseMs: 100, renewIntervalMs: 100, waitTimeoutMs: 50, pollIntervalMs: 10 },
        async () => 'worker',
        waiter
      )
    ).resolves.toBe('waited')
    expect(waiter).toHaveBeenCalledTimes(1)
  })

  it('releases the lock when renewIntervalMs is invalid for the acquired lock', async () => {
    const redis = new Redis()
    const coordinator = new RedisSingleFlightCoordinator({ client: redis, prefix: 'sf:invalid-renew' })

    await expect(
      coordinator.execute(
        'user:invalid',
        { leaseMs: 100, renewIntervalMs: 100, waitTimeoutMs: 50, pollIntervalMs: 10 },
        async () => 'value',
        async () => 'waited'
      )
    ).resolves.toBe('value')

    expect(await redis.get('sf:invalid-renew:user%3Ainvalid')).toBeNull()
  })

  it('uses the default renewal interval when renewIntervalMs is omitted', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-08T00:00:00Z'))

    try {
      const redis = new Redis()
      const coordinator = new RedisSingleFlightCoordinator({ client: redis, prefix: 'sf:default-renew' })
      let fetches = 0
      let releaseFirst!: () => void
      const firstReleased = new Promise<void>((resolve) => {
        releaseFirst = resolve
      })

      const first = coordinator.execute(
        'user:default',
        { leaseMs: 200, waitTimeoutMs: 300, pollIntervalMs: 10 },
        async () => {
          fetches += 1
          await firstReleased
          return 'value'
        },
        async () => 'waited'
      )

      await Promise.resolve()
      await vi.advanceTimersByTimeAsync(250)

      const second = coordinator.execute(
        'user:default',
        { leaseMs: 200, waitTimeoutMs: 300, pollIntervalMs: 10 },
        async () => {
          fetches += 1
          return 'duplicate'
        },
        async () => 'waited'
      )

      releaseFirst()

      await expect(Promise.all([first, second])).resolves.toEqual(['value', 'waited'])
      expect(fetches).toBe(1)
      expect(await redis.get('sf:default-renew:user%3Adefault')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('swallows renewal failures while still releasing the redis single-flight lock', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-08T00:00:00Z'))

    try {
      const client = {
        store: new Map<string, string>(),
        async set(key: string, token: string, ..._args: unknown[]) {
          this.store.set(key, token)
          return 'OK'
        },
        async eval(_script: string, _numKeys: number, key: string, token: string, leaseMs?: string) {
          if (leaseMs !== undefined) {
            throw new Error('renew failed')
          }

          if (this.store.get(key) === token) {
            this.store.delete(key)
            return 1
          }

          return 0
        },
        async get(key: string) {
          return this.store.get(key) ?? null
        }
      }

      const coordinator = new RedisSingleFlightCoordinator({
        client: client as unknown as Redis,
        prefix: 'sf:renew-failure'
      })

      let releaseFirst!: () => void
      const firstReleased = new Promise<void>((resolve) => {
        releaseFirst = resolve
      })

      const first = coordinator.execute(
        'user:renew-failure',
        { leaseMs: 100, renewIntervalMs: 25, waitTimeoutMs: 200, pollIntervalMs: 10 },
        async () => {
          await firstReleased
          return 'value'
        },
        async () => 'waited'
      )

      await Promise.resolve()
      await vi.advanceTimersByTimeAsync(25)
      releaseFirst()

      await expect(first).resolves.toBe('value')
      expect(await client.get('sf:renew-failure:user%3Arenew-failure')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('releases the lock when a redis single-flight worker throws', async () => {
    const redis = new Redis()
    const coordinator = new RedisSingleFlightCoordinator({ client: redis, prefix: 'sf:error' })

    await expect(
      coordinator.execute(
        'user:throw',
        { leaseMs: 100, waitTimeoutMs: 50, pollIntervalMs: 10 },
        async () => {
          throw new Error('boom')
        },
        async () => 'waited'
      )
    ).rejects.toThrow('boom')

    expect(await redis.get('sf:error:user%3Athrow')).toBeNull()
  })
})
