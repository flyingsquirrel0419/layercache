import Redis from 'ioredis-mock'
import { describe, expect, it } from 'vitest'
import { CacheStack } from '../src/CacheStack'
import { RedisTagIndex } from '../src/invalidation/RedisTagIndex'
import { MemoryLayer } from '../src/layers/MemoryLayer'
import { RedisLayer } from '../src/layers/RedisLayer'
import type { CacheLayer, InvalidationBus, InvalidationMessage } from '../src/types'

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

describe('CacheStack', () => {
  it('backfills upper layers on lower-layer hits', async () => {
    const redis = new Redis()
    const memoryLayer = new MemoryLayer({ ttl: 60 })
    const redisLayer = new RedisLayer({ client: redis, ttl: 120 })
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
    const cache = new CacheStack([new MemoryLayer({ ttl: 60 })])

    await cache.set('user:1', { id: 1 }, { tags: ['user', 'user:1'] })
    await cache.set('user:1:posts', [{ id: 9 }], { tags: ['user', 'user:1'] })
    await cache.invalidateByTag('user:1')

    await expect(cache.get('user:1')).resolves.toBeNull()
    await expect(cache.get('user:1:posts')).resolves.toBeNull()
  })

  it('invalidates by wildcard pattern', async () => {
    const cache = new CacheStack([new MemoryLayer({ ttl: 60 })])

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

  it('invalidates by wildcard pattern using actual layer keys after tag-index state is lost', async () => {
    const redis = new Redis()
    const redisLayer = new RedisLayer({ client: redis, ttl: 300, prefix: 'cache:pattern:' })
    const cache = new CacheStack([new MemoryLayer({ ttl: 60 }), redisLayer])

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
    const redisLayer = new RedisLayer({ client: redis, ttl: 300, prefix: 'cache:prefix:' })
    const cache = new CacheStack([new MemoryLayer({ ttl: 60 }), redisLayer])

    await redisLayer.set('user:1:profile', { id: 1 })
    await redisLayer.set('user:1:posts', [{ id: 1 }])
    await redisLayer.set('user:2:profile', { id: 2 })

    await cache.invalidateByPrefix('user:1:')

    await expect(redisLayer.get('user:1:profile')).resolves.toBeNull()
    await expect(redisLayer.get('user:1:posts')).resolves.toBeNull()
    await expect(redisLayer.get('user:2:profile')).resolves.toEqual({ id: 2 })
  })

  it('tracks cache metrics', async () => {
    const cache = new CacheStack([new MemoryLayer({ ttl: 60 })])

    await cache.get('miss')
    await cache.set('hit', 1)
    await cache.get('hit')

    expect(cache.getMetrics()).toMatchObject({
      hits: 1,
      misses: 1,
      sets: 1
    })
  })

  it('can clean up stale generations after a generation bump', async () => {
    const redis = new Redis()
    const redisLayer = new RedisLayer({ client: redis, ttl: 300, prefix: 'cache:generation:' })
    const cache = new CacheStack([new MemoryLayer({ ttl: 60 }), redisLayer], {
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

  it('propagates invalidation to local layers across bridge instances', async () => {
    const redis = new Redis()
    const bus = new InMemoryInvalidationBus()
    const cacheA = new CacheStack([new MemoryLayer({ ttl: 60 }), new RedisLayer({ client: redis, ttl: 300 })], {
      invalidationBus: bus,
      broadcastL1Invalidation: true
    })
    const memoryB = new MemoryLayer({ ttl: 60 })
    const cacheB = new CacheStack([memoryB, new RedisLayer({ client: redis, ttl: 300 })], { invalidationBus: bus })

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
    const cacheA = new CacheStack([new MemoryLayer({ ttl: 60 }), new RedisLayer({ client: redis, ttl: 300 })], {
      invalidationBus: bus
    })
    const memoryB = new MemoryLayer({ ttl: 60 })
    const cacheB = new CacheStack([memoryB, new RedisLayer({ client: redis, ttl: 300 })], { invalidationBus: bus })

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
      [new MemoryLayer({ ttl: 60 }), new RedisLayer({ client: redis, ttl: 300, prefix: 'cache:' })],
      { invalidationBus: bus, tagIndex: sharedTagIndex }
    )
    const memoryB = new MemoryLayer({ ttl: 60 })
    const cacheB = new CacheStack([memoryB, new RedisLayer({ client: redis, ttl: 300, prefix: 'cache:' })], {
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
    const cache = new CacheStack([new MemoryLayer({ ttl: 1 })])

    await cache.set('session:1', { id: 1 }, { tags: ['session'] })
    await new Promise((resolve) => setTimeout(resolve, 1_100))

    await expect(cache.get('session:1')).resolves.toBeNull()
    await cache.invalidateByTag('session')

    expect(cache.getMetrics().deletes).toBe(0)
  })

  it('can skip write-triggered invalidation broadcasts', async () => {
    const redis = new Redis()
    const bus = new InMemoryInvalidationBus()
    const memoryB = new MemoryLayer({ ttl: 60 })
    const cacheA = new CacheStack(
      [new MemoryLayer({ ttl: 60 }), new RedisLayer({ client: redis, ttl: 300, prefix: 'cache:' })],
      { invalidationBus: bus, publishSetInvalidation: false }
    )
    const cacheB = new CacheStack([memoryB, new RedisLayer({ client: redis, ttl: 300, prefix: 'cache:' })], {
      invalidationBus: bus
    })

    await cacheA.set('user:1', { id: 1, version: 1 })
    await cacheB.get('user:1')
    await cacheA.set('user:1', { id: 1, version: 2 })

    await expect(memoryB.get('user:1')).resolves.toEqual({ id: 1, version: 1 })

    await Promise.all([cacheA.disconnect(), cacheB.disconnect()])
  })

  it('rejects operations after disconnect begins', async () => {
    const cache = new CacheStack([new MemoryLayer({ ttl: 60 })])

    await cache.disconnect()

    await expect(cache.get('user:1')).rejects.toThrow(/disconnecting/i)
    await expect(cache.set('user:1', { id: 1 })).rejects.toThrow(/disconnecting/i)
  })
})
