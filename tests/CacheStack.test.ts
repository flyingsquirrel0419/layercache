import Redis from 'ioredis-mock'
import { describe, expect, it, vi } from 'vitest'
import { CacheStack } from '../src/CacheStack'
import { createStoredValueEnvelope } from '../src/internal/StoredValue'
import { RedisTagIndex } from '../src/invalidation/RedisTagIndex'
import { MemoryLayer } from '../src/layers/MemoryLayer'
import { RedisLayer } from '../src/layers/RedisLayer'
import { type CacheLayer, CacheMissError, type InvalidationBus, type InvalidationMessage } from '../src/types'

class RecordingLayer implements CacheLayer {
  readonly name: string
  readonly capturedTtls: Array<number | undefined> = []
  readonly values = new Map<string, unknown>()

  constructor(
    name: string,
    readonly defaultTtl?: number
  ) {
    this.name = name
  }

  async get<T>(key: string): Promise<T | null> {
    return (this.values.get(key) as T | undefined) ?? null
  }

  async set(key: string, value: unknown, ttl?: number): Promise<void> {
    this.capturedTtls.push(ttl)
    this.values.set(key, value)
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key)
  }

  async clear(): Promise<void> {
    this.values.clear()
  }
}

class RemoteLayerWithoutKeys extends RecordingLayer {
  readonly isLocal = false
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

describe('CacheStack', () => {
  it('backfills upper layers on lower-layer hits', async () => {
    const redis = new Redis()
    const memoryLayer = new MemoryLayer({ ttl: 60_000 })
    const redisLayer = new RedisLayer({ client: redis, ttl: 120_000 })
    const cache = new CacheStack([memoryLayer, redisLayer])

    await redisLayer.set('user:1', { id: 1 })

    await expect(cache.get('user:1')).resolves.toEqual({ id: 1 })
    await expect(memoryLayer.get('user:1')).resolves.toEqual({ id: 1 })
  })

  it('supports per-layer ttl overrides', async () => {
    const memoryLayer = new RecordingLayer('memory', 10)
    const redisLayer = new RecordingLayer('redis', 20)
    const cache = new CacheStack([memoryLayer, redisLayer])

    await cache.set('user:1', { id: 1 }, { ttl: { memory: 5, redis: 15 } })

    expect(memoryLayer.capturedTtls).toEqual([5])
    expect(redisLayer.capturedTtls).toEqual([15])
  })

  it('invalidates all keys for a tag', async () => {
    const cache = new CacheStack([new MemoryLayer({ ttl: 60_000 })])

    await cache.set('user:1', { id: 1 }, { tags: ['user', 'user:1'] })
    await cache.set('user:1:posts', [{ id: 9 }], { tags: ['user', 'user:1'] })
    await cache.invalidateByTag('user:1')

    await expect(cache.get('user:1')).resolves.toBeNull()
    await expect(cache.get('user:1:posts')).resolves.toBeNull()
  })

  it('expires tagged entries without deleting stale values', async () => {
    const cache = new CacheStack([new MemoryLayer({ ttl: 60_000 })])

    await cache.set('user:1', { version: 1 }, { ttl: 60_000, staleWhileRevalidate: 30_000, tags: ['user:1'] })
    await cache.expireByTag('user:1')

    await expect(cache.inspect('user:1')).resolves.toEqual(
      expect.objectContaining({
        freshTtlMs: 0,
        isStale: true
      })
    )

    const fetcher = vi.fn(async () => ({ version: 2 }))
    await expect(cache.get('user:1', fetcher)).resolves.toEqual({ version: 1 })
    await waitForCondition(async () => {
      await expect(cache.get('user:1')).resolves.toEqual({ version: 2 })
    })
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(cache.getMetrics().deletes).toBe(0)
  })

  it('invalidates exact keys without matching similarly prefixed keys', async () => {
    const cache = new CacheStack([new MemoryLayer({ ttl: 60_000 })])

    await cache.mset([
      { key: 'user:1', value: { id: 1 } },
      { key: 'user:1:posts', value: [{ id: 9 }] },
      { key: 'post:1', value: { id: 1 } }
    ])

    await cache.invalidateByKey('user:1')
    await expect(cache.get('user:1')).resolves.toBeNull()
    await expect(cache.get('user:1:posts')).resolves.toEqual([{ id: 9 }])

    await cache.invalidateByKeys(['user:1:posts', 'post:1'])
    await expect(cache.get('user:1:posts')).resolves.toBeNull()
    await expect(cache.get('post:1')).resolves.toBeNull()
  })

  it('expires exact keys without deleting stale values or touching similarly prefixed keys', async () => {
    const cache = new CacheStack([new MemoryLayer({ ttl: 60_000 })])

    await cache.mset([
      { key: 'user:1', value: { version: 1 }, options: { ttl: 60_000, staleWhileRevalidate: 30_000 } },
      { key: 'user:1:posts', value: [{ version: 1 }], options: { ttl: 60_000, staleWhileRevalidate: 30_000 } },
      { key: 'post:1', value: { version: 1 }, options: { ttl: 60_000, staleWhileRevalidate: 30_000 } }
    ])

    await cache.expireByKey('user:1')

    await expect(cache.inspect('user:1')).resolves.toEqual(expect.objectContaining({ freshTtlMs: 0, isStale: true }))
    await expect(cache.inspect('user:1:posts')).resolves.toEqual(expect.objectContaining({ isStale: false }))

    const fetcher = vi.fn(async () => ({ version: 2 }))
    await expect(cache.get('user:1', fetcher)).resolves.toEqual({ version: 1 })
    await waitForCondition(async () => {
      await expect(cache.get('user:1')).resolves.toEqual({ version: 2 })
    })

    await cache.expireByKeys(['user:1:posts', 'post:1'])
    await expect(cache.inspect('user:1:posts')).resolves.toEqual(expect.objectContaining({ isStale: true }))
    await expect(cache.inspect('post:1')).resolves.toEqual(expect.objectContaining({ isStale: true }))
    expect(cache.getMetrics().deletes).toBe(0)
  })

  it('rejects invalid tag input', async () => {
    const cache = new CacheStack([new MemoryLayer({ ttl: 60_000 })])

    await expect(cache.set('user:1', { id: 1 }, { tags: ['bad\u0000tag'] })).rejects.toThrow(/Cache tag/i)
    await expect(cache.invalidateByTag('bad\u0000tag')).rejects.toThrow(/Cache tag/i)
  })

  it('rejects tag invalidation when too many keys match', async () => {
    const cache = new CacheStack([new MemoryLayer({ ttl: 60_000 })], { invalidationMaxKeys: 1 })

    await cache.set('user:1', { id: 1 }, { tags: ['users'] })
    await cache.set('user:2', { id: 2 }, { tags: ['users'] })

    await expect(cache.invalidateByTag('users')).rejects.toThrow(/too many keys/i)
  })

  it('rejects multi-tag invalidation when too many keys match', async () => {
    const cache = new CacheStack([new MemoryLayer({ ttl: 60_000 })], { invalidationMaxKeys: 1 })

    await cache.set('user:1', { id: 1 }, { tags: ['users', 'tenant:a'] })
    await cache.set('user:2', { id: 2 }, { tags: ['users'] })

    await expect(cache.invalidateByTags(['users', 'tenant:a'], 'any')).rejects.toThrow(/too many keys/i)
  })

  it('expires by tags, pattern, and prefix using the existing match rules', async () => {
    const cache = new CacheStack([new MemoryLayer({ ttl: 60_000 })])

    await cache.mset([
      {
        key: 'user:1',
        value: { id: 1 },
        options: { ttl: 60_000, staleWhileRevalidate: 30_000, tags: ['users', 'tenant:a'] }
      },
      { key: 'user:2', value: { id: 2 }, options: { ttl: 60_000, staleWhileRevalidate: 30_000, tags: ['users'] } },
      { key: 'post:1', value: { id: 1 }, options: { ttl: 60_000, staleWhileRevalidate: 30_000 } },
      { key: 'post:2', value: { id: 2 }, options: { ttl: 60_000, staleWhileRevalidate: 30_000 } }
    ])

    await cache.expireByTags(['users', 'tenant:a'], 'all')
    await expect(cache.inspect('user:1')).resolves.toEqual(expect.objectContaining({ isStale: true }))
    await expect(cache.inspect('user:2')).resolves.toEqual(expect.objectContaining({ isStale: false }))

    await cache.expireByPattern('post:1')
    await expect(cache.inspect('post:1')).resolves.toEqual(expect.objectContaining({ isStale: true }))
    await expect(cache.inspect('post:2')).resolves.toEqual(expect.objectContaining({ isStale: false }))

    await cache.expireByPrefix('post:')
    await expect(cache.inspect('post:2')).resolves.toEqual(expect.objectContaining({ isStale: true }))
  })

  it('treats empty batch invalidations and unmatched expirations as no-ops', async () => {
    const cache = new CacheStack([new MemoryLayer({ ttl: 60_000 })])

    await cache.set('user:1', { id: 1 }, { ttl: 60_000, staleWhileRevalidate: 30_000, tags: ['users'] })

    await cache.invalidateByTags([])
    await cache.expireByTags([])
    await cache.expireByKeys([])
    await cache.expireByPattern('missing:*')

    await expect(cache.inspect('user:1')).resolves.toEqual(expect.objectContaining({ isStale: false }))

    cache.resetMetrics()
    expect(cache.getMetrics().sets).toBe(0)
    expect(cache.getMetrics().invalidations).toBe(0)
  })

  it('invalidates by wildcard pattern', async () => {
    const cache = new CacheStack([new MemoryLayer({ ttl: 60_000 })])

    await cache.mset([
      { key: 'user:1', value: { id: 1 } },
      { key: 'user:2', value: { id: 2 } },
      { key: 'post:1', value: { id: 1 } }
    ])
    await cache.invalidateByPattern('user:*')

    await expect(cache.get('user:1')).resolves.toBeNull()
    await expect(cache.get('user:2')).resolves.toBeNull()
    await expect(cache.get('post:1')).resolves.toEqual({ id: 1 })
  })

  it('rejects wildcard invalidation when too many keys match', async () => {
    const cache = new CacheStack([new MemoryLayer({ ttl: 60_000 })], { invalidationMaxKeys: 1 })

    await cache.mset([
      { key: 'user:1', value: { id: 1 } },
      { key: 'user:2', value: { id: 2 } }
    ])

    await expect(cache.invalidateByPattern('user:*')).rejects.toThrow(/too many keys/i)
  })

  it('invalidates by wildcard pattern using actual layer keys after tag-index state is lost', async () => {
    const redis = new Redis()
    const redisLayer = new RedisLayer({ client: redis, ttl: 300_000, prefix: 'cache:pattern:' })
    const cache = new CacheStack([new MemoryLayer({ ttl: 60_000 }), redisLayer])

    await redisLayer.set('user:1', { id: 1 })
    await redisLayer.set('user:2', { id: 2 })
    await redisLayer.set('post:1', { id: 1 })

    await cache.invalidateByPattern('user:*')

    await expect(redisLayer.get('user:1')).resolves.toBeNull()
    await expect(redisLayer.get('user:2')).resolves.toBeNull()
    await expect(redisLayer.get('post:1')).resolves.toEqual({ id: 1 })
  })

  it('invalidates by prefix using actual layer keys after tag-index state is lost', async () => {
    const redis = new Redis()
    const redisLayer = new RedisLayer({ client: redis, ttl: 300_000, prefix: 'cache:prefix:' })
    const cache = new CacheStack([new MemoryLayer({ ttl: 60_000 }), redisLayer])

    await redisLayer.set('user:1:profile', { id: 1 })
    await redisLayer.set('user:1:posts', [{ id: 1 }])
    await redisLayer.set('user:2:profile', { id: 2 })

    await cache.invalidateByPrefix('user:1:')

    await expect(redisLayer.get('user:1:profile')).resolves.toBeNull()
    await expect(redisLayer.get('user:1:posts')).resolves.toBeNull()
    await expect(redisLayer.get('user:2:profile')).resolves.toEqual({ id: 2 })
  })

  it('rejects prefix invalidation when too many keys match', async () => {
    const cache = new CacheStack([new MemoryLayer({ ttl: 60_000 })], { invalidationMaxKeys: 1 })

    await cache.mset([
      { key: 'user:1:profile', value: { id: 1 } },
      { key: 'user:1:posts', value: [{ id: 1 }] }
    ])

    await expect(cache.invalidateByPrefix('user:1:')).rejects.toThrow(/too many keys/i)
  })

  it('rejects expiration when too many keys match without partially expiring entries', async () => {
    const cache = new CacheStack([new MemoryLayer({ ttl: 60_000 })], { invalidationMaxKeys: 1 })

    await cache.mset([
      { key: 'user:1:profile', value: { id: 1 }, options: { ttl: 60_000, staleWhileRevalidate: 30_000 } },
      { key: 'user:1:posts', value: [{ id: 1 }], options: { ttl: 60_000, staleWhileRevalidate: 30_000 } }
    ])

    await expect(cache.expireByPrefix('user:1:')).rejects.toThrow(/too many keys/i)
    await expect(cache.inspect('user:1:profile')).resolves.toEqual(expect.objectContaining({ isStale: false }))
    await expect(cache.inspect('user:1:posts')).resolves.toEqual(expect.objectContaining({ isStale: false }))
  })

  it('tracks cache metrics', async () => {
    const cache = new CacheStack([new MemoryLayer({ ttl: 60_000 })])

    await cache.get('miss')
    await cache.set('hit', 1)
    await cache.get('hit')

    expect(cache.getMetrics()).toMatchObject({
      hits: 1,
      misses: 1,
      sets: 1
    })
  })

  it('throws CacheMissError from getOrThrow when the key is missing', async () => {
    const cache = new CacheStack([new MemoryLayer({ ttl: 60_000 })])

    await expect(cache.getOrThrow('missing')).rejects.toBeInstanceOf(CacheMissError)
    await expect(cache.getOrThrow('missing')).rejects.toMatchObject({ key: 'missing' })
  })

  it('supports shared circuit breaker scope across different cache keys', async () => {
    const cache = new CacheStack([new MemoryLayer({ ttl: 60_000 })], {
      circuitBreaker: { failureThreshold: 1, cooldownMs: 60_000, scope: 'shared', breakerKey: 'api' }
    })
    const firstFetcher = vi.fn(async () => {
      throw new Error('backend down')
    })
    const secondFetcher = vi.fn(async () => 'should-not-run')

    await expect(cache.get('user:1', firstFetcher)).rejects.toThrow(/backend down/i)
    await expect(cache.get('user:2', secondFetcher)).rejects.toThrow(/Circuit breaker is open/i)
    expect(secondFetcher).not.toHaveBeenCalled()
  })

  it('keeps circuit breaker buckets disjoint for key, shared, and custom scopes', async () => {
    const cache = new CacheStack([new MemoryLayer({ ttl: 60_000 })])
    const failingFetcher = vi.fn(async () => {
      throw new Error('backend down')
    })
    const sharedFetcher = vi.fn(async () => 'shared-ok')
    const customFetcher = vi.fn(async () => 'custom-ok')

    await expect(
      cache.get('shared', failingFetcher, {
        circuitBreaker: { failureThreshold: 1, cooldownMs: 60_000 }
      })
    ).rejects.toThrow(/backend down/i)
    await expect(
      cache.get('other', sharedFetcher, {
        circuitBreaker: { failureThreshold: 1, cooldownMs: 60_000, scope: 'shared' }
      })
    ).resolves.toBe('shared-ok')
    await expect(
      cache.get('custom:api', customFetcher, {
        circuitBreaker: { failureThreshold: 1, cooldownMs: 60_000, breakerKey: 'api' }
      })
    ).resolves.toBe('custom-ok')

    expect(sharedFetcher).toHaveBeenCalledOnce()
    expect(customFetcher).toHaveBeenCalledOnce()
  })

  it('getEntry distinguishes stored null values and negative-cache entries from misses', async () => {
    const cache = new CacheStack([new MemoryLayer({ ttl: 60_000 })])

    await cache.set('stored-null', null)
    await expect(cache.get('stored-null')).resolves.toBeNull()
    await expect(cache.getEntry('stored-null')).resolves.toEqual(
      expect.objectContaining({
        key: 'stored-null',
        value: null,
        kind: 'value',
        state: 'fresh',
        layer: 'memory'
      })
    )

    await cache.get('negative-null', async () => null, { negativeCache: true })
    await expect(cache.getEntry('negative-null')).resolves.toEqual(
      expect.objectContaining({
        key: 'negative-null',
        value: null,
        kind: 'empty',
        state: 'fresh'
      })
    )
    await expect(cache.getEntry('missing')).resolves.toBeNull()
  })

  it('getEntry records read side effects and backfills faster layers', async () => {
    const memory = new RecordingLayer('memory')
    const redis = new RecordingLayer('redis')
    redis.values.set('profile:1', 'cached')
    const cache = new CacheStack([memory, redis])

    await expect(cache.getEntry('profile:1')).resolves.toEqual(
      expect.objectContaining({
        key: 'profile:1',
        value: 'cached',
        kind: 'value',
        state: 'fresh',
        layer: 'redis'
      })
    )

    expect(memory.values.get('profile:1')).toBe('cached')
    const metrics = cache.getMetrics()
    expect(metrics.hits).toBe(1)
    expect(metrics.backfills).toBe(1)
    expect(metrics.hitsByLayer.redis).toBe(1)
    expect(metrics.missesByLayer.memory).toBe(1)
  })

  it('continues has() checks when layer.has() fails or returns false', async () => {
    const warn = vi.fn()
    const flakyHasLayer: CacheLayer = {
      name: 'flaky-has',
      get: async () => null,
      set: async () => undefined,
      delete: async () => undefined,
      clear: async () => undefined,
      has: async () => {
        throw new Error('has broke')
      }
    }
    const falseHasLayer: CacheLayer = {
      name: 'false-has',
      get: async () => null,
      set: async () => undefined,
      delete: async () => undefined,
      clear: async () => undefined,
      has: async () => false
    }
    const trueHasLayer: CacheLayer = {
      name: 'true-has',
      get: async () => 'value',
      set: async () => undefined,
      delete: async () => undefined,
      clear: async () => undefined,
      has: async () => true
    }
    const cache = new CacheStack([flakyHasLayer, falseHasLayer, trueHasLayer], {
      logger: { warn }
    })

    await expect(cache.has('user:1')).resolves.toBe(true)
    expect(warn).toHaveBeenCalledWith(
      'layer-operation-failed',
      expect.objectContaining({
        layer: 'flaky-has',
        operation: 'has',
        error: 'has() failed for layer "flaky-has"'
      })
    )
  })

  it('returns null from ttl() when every layer misses or ttl lookup fails', async () => {
    const cache = new CacheStack([
      {
        name: 'ttl-throws',
        get: async () => null,
        set: async () => undefined,
        delete: async () => undefined,
        clear: async () => undefined,
        ttl: async () => {
          throw new Error('ttl broke')
        }
      },
      {
        name: 'ttl-null',
        get: async () => null,
        set: async () => undefined,
        delete: async () => undefined,
        clear: async () => undefined,
        ttl: async () => null
      },
      {
        name: 'ttl-absent',
        get: async () => null,
        set: async () => undefined,
        delete: async () => undefined,
        clear: async () => undefined
      }
    ])

    await expect(cache.ttl('user:1')).resolves.toBeNull()
  })

  it('can clean up stale generations after a generation bump', async () => {
    const redis = new Redis()
    const redisLayer = new RedisLayer({ client: redis, ttl: 300_000, prefix: 'cache:generation:' })
    const cache = new CacheStack([new MemoryLayer({ ttl: 60_000 }), redisLayer], {
      generation: 1,
      generationCleanup: { batchSize: 1 }
    })

    await cache.set('user:1', { id: 1 })
    await expect(redisLayer.get('v1:user:1')).resolves.toEqual({ id: 1 })

    cache.bumpGeneration()

    for (let attempt = 0; attempt < 20; attempt += 1) {
      if ((await redisLayer.get('v1:user:1')) === null) {
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 10))
    }

    await expect(redisLayer.get('v1:user:1')).resolves.toBeNull()
  })

  it('reports the active generation number', () => {
    const cache = new CacheStack([new MemoryLayer({ ttl: 60_000 })], { generation: 1 })

    expect(cache.getGeneration()).toBe(1)
    expect(cache.bumpGeneration()).toBe(2)
    expect(cache.getGeneration()).toBe(2)
    expect(cache.bumpGeneration(7)).toBe(7)
    expect(cache.getGeneration()).toBe(7)
  })

  it('reports generation cleanup failures through the public generation bump flow', async () => {
    const warn = vi.fn()
    const brokenCleanupLayer: CacheLayer = {
      name: 'broken-cleanup',
      get: async () => null,
      set: async () => undefined,
      delete: async () => undefined,
      clear: async () => undefined,
      keys: async () => {
        throw new Error('cleanup failed')
      }
    }
    const cache = new CacheStack([brokenCleanupLayer], {
      generation: 1,
      generationCleanup: true,
      logger: { warn }
    })

    cache.bumpGeneration(2)

    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (warn.mock.calls.some(([message]) => message === 'generation-cleanup-error')) {
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 10))
    }

    expect(warn).toHaveBeenCalledWith(
      'generation-cleanup-error',
      expect.objectContaining({ generation: 1, error: 'cleanup failed' })
    )
  })

  it('skips deleteMany calls on publicly degraded layers', async () => {
    const degradedDeleteMany = vi.fn(async (_keys: string[]) => undefined)
    const degradedLayer: CacheLayer = {
      name: 'degraded-delete',
      get: async () => {
        throw new Error('read failed')
      },
      set: async () => undefined,
      delete: async () => undefined,
      clear: async () => undefined,
      deleteMany: degradedDeleteMany
    }
    const healthyLayer = new RecordingLayer('healthy', 60)
    const cache = new CacheStack([degradedLayer, healthyLayer], {
      gracefulDegradation: true
    })

    await expect(cache.has('user:1')).resolves.toBe(false)
    expect(cache.getStats().layers.find((layer) => layer.name === 'degraded-delete')?.degradedUntil).not.toBeNull()

    await expect(cache.mdelete(['user:1'])).resolves.toBeUndefined()
    expect(degradedDeleteMany).not.toHaveBeenCalled()
  })

  it('skips sliding-ttl writes to layers that were publicly degraded earlier', async () => {
    const degradedSet = vi.fn(async () => undefined)
    const degradedLayer: CacheLayer = {
      name: 'degraded-sliding',
      get: async () => {
        throw new Error('read failed')
      },
      set: degradedSet,
      delete: async () => undefined,
      clear: async () => undefined
    }
    const healthyLayer = new RecordingLayer('healthy-sliding', 60)
    const cache = new CacheStack([degradedLayer, healthyLayer], {
      gracefulDegradation: true
    })

    await expect(cache.get('missing')).resolves.toBeNull()
    expect(cache.getStats().layers.find((layer) => layer.name === 'degraded-sliding')?.degradedUntil).not.toBeNull()

    await healthyLayer.set(
      'user:1',
      createStoredValueEnvelope({
        kind: 'value',
        value: { id: 1 },
        freshTtlMs: 2_000
      }),
      2
    )

    degradedSet.mockClear()

    await expect(cache.get('user:1', undefined, { slidingTtl: true })).resolves.toEqual({ id: 1 })
    expect(degradedSet).not.toHaveBeenCalled()
  })

  it('propagates invalidation to local layers across bridge instances', async () => {
    const redis = new Redis()
    const bus = new InMemoryInvalidationBus()
    const cacheA = new CacheStack([new MemoryLayer({ ttl: 60_000 }), new RedisLayer({ client: redis, ttl: 300_000 })], {
      invalidationBus: bus,
      broadcastL1Invalidation: true
    })
    const memoryB = new MemoryLayer({ ttl: 60_000 })
    const cacheB = new CacheStack([memoryB, new RedisLayer({ client: redis, ttl: 300_000 })], { invalidationBus: bus })

    await cacheA.set('user:1', { id: 1, version: 1 })
    await expect(cacheB.get('user:1')).resolves.toEqual({ id: 1, version: 1 })
    await expect(memoryB.get('user:1')).resolves.toEqual({ id: 1, version: 1 })

    await cacheA.set('user:1', { id: 1, version: 2 })

    await expect(memoryB.get('user:1')).resolves.toBeNull()
    await expect(cacheB.get('user:1')).resolves.toEqual({ id: 1, version: 2 })

    await Promise.all([cacheA.disconnect(), cacheB.disconnect()])
  })

  it('does not broadcast write invalidations by default', async () => {
    const redis = new Redis()
    const bus = new InMemoryInvalidationBus()
    const cacheA = new CacheStack([new MemoryLayer({ ttl: 60_000 }), new RedisLayer({ client: redis, ttl: 300_000 })], {
      invalidationBus: bus
    })
    const memoryB = new MemoryLayer({ ttl: 60_000 })
    const cacheB = new CacheStack([memoryB, new RedisLayer({ client: redis, ttl: 300_000 })], { invalidationBus: bus })

    await cacheA.set('user:1', { id: 1, version: 1 })
    await expect(cacheB.get('user:1')).resolves.toEqual({ id: 1, version: 1 })
    await expect(memoryB.get('user:1')).resolves.toEqual({ id: 1, version: 1 })

    await cacheA.set('user:1', { id: 1, version: 2 })

    await expect(memoryB.get('user:1')).resolves.toEqual({ id: 1, version: 1 })

    await Promise.all([cacheA.disconnect(), cacheB.disconnect()])
  })

  it('supports distributed tag invalidation with a shared redis tag index', async () => {
    const redis = new Redis()
    const bus = new InMemoryInvalidationBus()
    const sharedTagIndex = new RedisTagIndex({ client: redis, prefix: 'tag-index:test' })
    const cacheA = new CacheStack(
      [new MemoryLayer({ ttl: 60_000 }), new RedisLayer({ client: redis, ttl: 300_000, prefix: 'cache:' })],
      { invalidationBus: bus, tagIndex: sharedTagIndex }
    )
    const memoryB = new MemoryLayer({ ttl: 60_000 })
    const cacheB = new CacheStack([memoryB, new RedisLayer({ client: redis, ttl: 300_000, prefix: 'cache:' })], {
      invalidationBus: bus,
      tagIndex: sharedTagIndex
    })

    await cacheA.set('user:1', { id: 1 }, { tags: ['user:1'] })
    await cacheB.set('user:1:posts', [{ id: 99 }], { tags: ['user:1'] })
    await expect(cacheB.get('user:1')).resolves.toEqual({ id: 1 })
    await expect(memoryB.get('user:1')).resolves.toEqual({ id: 1 })

    await cacheA.invalidateByTag('user:1')

    await expect(cacheA.get('user:1')).resolves.toBeNull()
    await expect(cacheB.get('user:1:posts')).resolves.toBeNull()
    await expect(memoryB.get('user:1')).resolves.toBeNull()

    await Promise.all([cacheA.disconnect(), cacheB.disconnect()])
  })

  it('broadcasts tag expiration without deleting remote local stale values', async () => {
    const redis = new Redis()
    const bus = new InMemoryInvalidationBus()
    const sharedTagIndex = new RedisTagIndex({ client: redis, prefix: 'tag-index:expire' })
    const cacheA = new CacheStack(
      [new MemoryLayer({ ttl: 60_000 }), new RedisLayer({ client: redis, ttl: 300_000, prefix: 'cache:expire:' })],
      { invalidationBus: bus, tagIndex: sharedTagIndex }
    )
    const memoryB = new MemoryLayer({ ttl: 60_000 })
    const cacheB = new CacheStack([memoryB, new RedisLayer({ client: redis, ttl: 300_000, prefix: 'cache:expire:' })], {
      invalidationBus: bus,
      tagIndex: sharedTagIndex
    })

    await cacheA.set('user:1', { version: 1 }, { ttl: 60_000, staleWhileRevalidate: 30_000, tags: ['user:1'] })
    await expect(cacheB.get('user:1')).resolves.toEqual({ version: 1 })
    await expect(memoryB.get('user:1')).resolves.toEqual({ version: 1 })

    await cacheA.expireByTag('user:1')

    await expect(memoryB.get('user:1')).resolves.toEqual({ version: 1 })
    await expect(cacheB.inspect('user:1')).resolves.toEqual(
      expect.objectContaining({
        freshTtlMs: 0,
        isStale: true
      })
    )

    const fetcher = vi.fn(async () => ({ version: 2 }))
    await expect(cacheB.get('user:1', fetcher)).resolves.toEqual({ version: 1 })
    await waitForCondition(async () => {
      await expect(cacheB.get('user:1')).resolves.toEqual({ version: 2 })
    })
    expect(fetcher).toHaveBeenCalledTimes(1)

    await Promise.all([cacheA.disconnect(), cacheB.disconnect()])
  })

  it('clears remote circuit-breaker state on distributed clear', async () => {
    const bus = new InMemoryInvalidationBus()
    const cacheA = new CacheStack([new MemoryLayer({ ttl: 60_000 })], { invalidationBus: bus })
    const cacheB = new CacheStack([new MemoryLayer({ ttl: 60_000 })], { invalidationBus: bus })
    const breaker = { failureThreshold: 1, cooldownMs: 60_000 }

    const failingFetcher = vi.fn(async () => {
      throw new Error('upstream unavailable')
    })

    await expect(cacheB.get('user:1', failingFetcher, { circuitBreaker: breaker })).rejects.toThrow(
      /upstream unavailable/i
    )
    await expect(cacheB.get('user:1', failingFetcher, { circuitBreaker: breaker })).rejects.toThrow(
      /Circuit breaker is open/i
    )

    await cacheA.clear()

    const succeedingFetcher = vi.fn(async () => ({ id: 1 }))
    await expect(cacheB.get('user:1', succeedingFetcher, { circuitBreaker: breaker })).resolves.toEqual({ id: 1 })
    expect(succeedingFetcher).toHaveBeenCalledTimes(1)

    await Promise.all([cacheA.disconnect(), cacheB.disconnect()])
  })

  it('clears remote circuit-breaker state on distributed key deletion', async () => {
    const bus = new InMemoryInvalidationBus()
    const cacheA = new CacheStack([new MemoryLayer({ ttl: 60_000 })], { invalidationBus: bus })
    const cacheB = new CacheStack([new MemoryLayer({ ttl: 60_000 })], { invalidationBus: bus })
    const breaker = { failureThreshold: 1, cooldownMs: 60_000 }

    const failingFetcher = vi.fn(async () => {
      throw new Error('upstream unavailable')
    })

    await expect(cacheB.get('user:1', failingFetcher, { circuitBreaker: breaker })).rejects.toThrow(
      /upstream unavailable/i
    )
    await expect(cacheB.get('user:1', failingFetcher, { circuitBreaker: breaker })).rejects.toThrow(
      /Circuit breaker is open/i
    )

    await cacheA.delete('user:1')

    const succeedingFetcher = vi.fn(async () => ({ id: 1 }))
    await expect(cacheB.get('user:1', succeedingFetcher, { circuitBreaker: breaker })).resolves.toEqual({ id: 1 })
    expect(succeedingFetcher).toHaveBeenCalledTimes(1)

    await Promise.all([cacheA.disconnect(), cacheB.disconnect()])
  })

  it('matches redis tag patterns via incremental set scanning', async () => {
    const redis = new Redis()
    const originalSscan = redis.sscan.bind(redis)
    let sscanCalls = 0

    redis.sscan = (async (...args: Parameters<typeof originalSscan>) => {
      sscanCalls += 1
      return originalSscan(...args)
    }) as typeof redis.sscan

    const tagIndex = new RedisTagIndex({ client: redis, prefix: 'tag-index:scan', scanCount: 1 })
    await tagIndex.touch('user:1')
    await tagIndex.touch('user:2')
    await tagIndex.touch('post:1')

    const matches = await tagIndex.matchPattern('user:*')
    expect(matches.sort()).toEqual(['user:1', 'user:2'])
    expect(sscanCalls).toBeGreaterThan(0)
  })

  it('removes stale tag entries when a tagged key has expired from every layer', async () => {
    const cache = new CacheStack([new MemoryLayer({ ttl: 1_000 })])

    await cache.set('session:1', { id: 1 }, { tags: ['session'] })
    await new Promise((resolve) => setTimeout(resolve, 1_100))

    await expect(cache.get('session:1')).resolves.toBeNull()
    await cache.invalidateByTag('session')

    expect(cache.getMetrics().deletes).toBe(0)
  })

  it('removes stale tag entries when expiration finds no stored value', async () => {
    const tagIndex = {
      clear: vi.fn(async () => undefined),
      keysForTag: vi.fn(async () => ['session:missing']),
      matchPattern: vi.fn(async () => []),
      remove: vi.fn(async () => undefined),
      touch: vi.fn(async () => undefined),
      track: vi.fn(async () => undefined)
    }
    const cache = new CacheStack([new MemoryLayer({ ttl: 60_000 })], { tagIndex: tagIndex as never })

    await cache.expireByTag('session')

    expect(tagIndex.remove).toHaveBeenCalledWith('session:missing')
    expect(cache.getMetrics().deletes).toBe(0)
    expect(cache.getMetrics().invalidations).toBe(1)
  })

  it('can skip write-triggered invalidation broadcasts', async () => {
    const redis = new Redis()
    const bus = new InMemoryInvalidationBus()
    const memoryB = new MemoryLayer({ ttl: 60_000 })
    const cacheA = new CacheStack(
      [new MemoryLayer({ ttl: 60_000 }), new RedisLayer({ client: redis, ttl: 300_000, prefix: 'cache:' })],
      { invalidationBus: bus, publishSetInvalidation: false }
    )
    const cacheB = new CacheStack([memoryB, new RedisLayer({ client: redis, ttl: 300_000, prefix: 'cache:' })], {
      invalidationBus: bus
    })

    await cacheA.set('user:1', { id: 1, version: 1 })
    await cacheB.get('user:1')
    await cacheA.set('user:1', { id: 1, version: 2 })

    await expect(memoryB.get('user:1')).resolves.toEqual({ id: 1, version: 1 })

    await Promise.all([cacheA.disconnect(), cacheB.disconnect()])
  })

  it('rejects operations after disconnect begins', async () => {
    const cache = new CacheStack([new MemoryLayer({ ttl: 60_000 })])

    await cache.disconnect()

    await expect(cache.get('user:1')).rejects.toThrow(/disconnecting/i)
    await expect(cache.set('user:1', { id: 1 })).rejects.toThrow(/disconnecting/i)
  })

  it('warns when shared layers without keys() rely on the default tag index', () => {
    const logger = { warn: vi.fn() }

    new CacheStack([new RemoteLayerWithoutKeys('remote')], { logger })

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining(
        'default in-memory TagIndex with a shared cache layer only tracks keys seen by this process'
      )
    )
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining(
        'does not implement keys() can leave invalidateByPattern() and invalidateByPrefix() incomplete'
      )
    )
  })
})
