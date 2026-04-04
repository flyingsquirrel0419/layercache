import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import Redis from 'ioredis-mock'
import { describe, expect, it, vi } from 'vitest'
import { CacheStack } from '../../src/CacheStack'
import { createCachedMethodDecorator } from '../../src/decorators/createCachedMethodDecorator'
import { createCacheStatsHandler } from '../../src/http/createCacheStatsHandler'
import { MemoryLayer } from '../../src/layers/MemoryLayer'
import { RedisLayer } from '../../src/layers/RedisLayer'
import type { CacheLayer } from '../../src/types'

class ExplodingLayer implements CacheLayer {
  readonly name = 'exploding'

  async get(): Promise<null> {
    throw new Error('layer unavailable')
  }

  async set(): Promise<void> {
    throw new Error('layer unavailable')
  }

  async delete(): Promise<void> {
    throw new Error('layer unavailable')
  }

  async clear(): Promise<void> {
    throw new Error('layer unavailable')
  }
}

describe('growth features', () => {
  it('supports wrap, warm, and namespaced access', async () => {
    const cache = new CacheStack([new MemoryLayer({ ttl: 60 })])
    const getUser = cache.wrap('user', async (id: number) => ({ id }), { ttl: 30 })

    await cache.warm([
      {
        key: 'config:flags',
        fetcher: async () => ({ enabled: true }),
        options: { ttl: 30 }
      }
    ])

    await expect(cache.get('config:flags')).resolves.toEqual({ enabled: true })
    await expect(getUser(1)).resolves.toEqual({ id: 1 })

    const namespace = cache.namespace('products')
    await namespace.set('top', ['sku-1'])
    await expect(namespace.get('top')).resolves.toEqual(['sku-1'])

    await cache.set('other:key', 1)
    await namespace.clear()

    await expect(namespace.get('top')).resolves.toBeNull()
    await expect(cache.get('other:key')).resolves.toBe(1)
  })

  it('supports snapshots on disk and export/import in memory', async () => {
    const first = new CacheStack([new MemoryLayer({ ttl: 60 })])
    await first.set('user:1', { id: 1 }, { ttl: 30 })

    const snapshot = await first.exportState()
    const second = new CacheStack([new MemoryLayer({ ttl: 60 })])
    await second.importState(snapshot)
    await expect(second.get('user:1')).resolves.toEqual({ id: 1 })

    const dir = await mkdtemp(join(tmpdir(), 'layercache-'))
    const filePath = join(dir, 'snapshot.json')

    try {
      await first.persistToFile(filePath)
      const third = new CacheStack([new MemoryLayer({ ttl: 60 })])
      await third.restoreFromFile(filePath)

      await expect(third.get('user:1')).resolves.toEqual({ id: 1 })
      await expect(readFile(filePath, 'utf8')).resolves.toContain('user:1')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('supports sliding ttl and adaptive ttl', async () => {
    const layer = new MemoryLayer({ ttl: 60 })
    const cache = new CacheStack([layer])

    await cache.set('sliding', { ok: true }, { ttl: 1 })
    await new Promise((resolve) => setTimeout(resolve, 700))
    await expect(cache.get('sliding', undefined, { slidingTtl: true })).resolves.toEqual({ ok: true })
    await new Promise((resolve) => setTimeout(resolve, 700))
    await expect(cache.get('sliding')).resolves.toEqual({ ok: true })

    await cache.set('adaptive', { ok: true }, { ttl: 10 })
    await cache.get('adaptive')
    await cache.get('adaptive')
    await cache.get('adaptive')
    await cache.set('adaptive', { ok: true }, {
      ttl: 10,
      adaptiveTtl: { hotAfter: 2, step: 5, maxTtl: 20 }
    })

    const stored = await layer.getEntry<{ freshUntil?: number }>('adaptive')
    expect(stored).not.toBeNull()
    if (stored && typeof stored === 'object' && 'freshUntil' in stored) {
      const ttlSeconds = Math.round((((stored as { freshUntil: number }).freshUntil) - Date.now()) / 1_000)
      expect(ttlSeconds).toBeGreaterThanOrEqual(14)
    }
  })

  it('degrades unhealthy layers and opens circuit breakers for failing fetchers', async () => {
    const cache = new CacheStack(
      [new ExplodingLayer(), new MemoryLayer({ ttl: 60 })],
      { gracefulDegradation: { retryAfterMs: 1_000 } }
    )

    await cache.set('user:1', { id: 1 })
    await expect(cache.get('user:1')).resolves.toEqual({ id: 1 })
    expect(cache.getStats().layers.find((layer) => layer.name === 'exploding')?.degradedUntil).not.toBeNull()

    const breakerCache = new CacheStack([new MemoryLayer({ ttl: 60 })])
    const fetcher = vi.fn(async () => {
      throw new Error('upstream unavailable')
    })

    await expect(
      breakerCache.get('circuit:key', fetcher, { circuitBreaker: { failureThreshold: 1, cooldownMs: 1_000 } })
    ).rejects.toThrow(/upstream unavailable/i)
    await expect(
      breakerCache.get('circuit:key', fetcher, { circuitBreaker: { failureThreshold: 1, cooldownMs: 1_000 } })
    ).rejects.toThrow(/Circuit breaker is open/i)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('supports compressed redis payloads and stats handlers', async () => {
    const redis = new Redis()
    const layer = new RedisLayer({
      client: redis,
      compression: 'gzip',
      compressionThreshold: 1
    })

    await layer.set('large', { payload: 'x'.repeat(128) })
    const raw = await redis.getBuffer('large')
    expect(raw?.subarray(0, 10).toString()).toBe('LCZ1:gzip:')
    await expect(layer.get('large')).resolves.toEqual({ payload: 'x'.repeat(128) })

    const cache = new CacheStack([new MemoryLayer({ ttl: 60 })])
    await cache.set('stats:key', { ok: true })

    const handler = createCacheStatsHandler(cache)
    let body = ''
    await handler({}, {
      setHeader: () => undefined,
      end: (chunk: string) => {
        body = chunk
      }
    })

    expect(body).toContain('"sets": 1')
  })

  it('creates cache-backed method decorators', async () => {
    const cache = new CacheStack([new MemoryLayer({ ttl: 60 })])
    let executions = 0

    class Service {
      readonly cache = cache

      async loadUser(id: number): Promise<{ id: number }> {
        executions += 1
        return { id }
      }
    }

    const descriptor = Object.getOwnPropertyDescriptor(Service.prototype, 'loadUser')
    if (!descriptor) {
      throw new Error('Missing method descriptor')
    }

    createCachedMethodDecorator({
      cache: (instance) => (instance as Service).cache,
      prefix: 'decorated:user'
    })(Service.prototype, 'loadUser', descriptor)
    Object.defineProperty(Service.prototype, 'loadUser', descriptor)

    const service = new Service()
    await expect(service.loadUser(1)).resolves.toEqual({ id: 1 })
    await expect(service.loadUser(1)).resolves.toEqual({ id: 1 })
    expect(executions).toBe(1)
  })
})
