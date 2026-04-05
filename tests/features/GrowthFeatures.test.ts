import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Redis from 'ioredis-mock'
import { describe, expect, it, vi } from 'vitest'
import { CacheStack } from '../../src/CacheStack'
import { createCachedMethodDecorator } from '../../src/decorators/createCachedMethodDecorator'
import { createCacheStatsHandler } from '../../src/http/createCacheStatsHandler'
import { createHonoCacheMiddleware } from '../../src/integrations/hono'
import { createOpenTelemetryPlugin } from '../../src/integrations/opentelemetry'
import { createTrpcCacheMiddleware } from '../../src/integrations/trpc'
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
    expect(namespace.getMetrics().sets).toBeGreaterThanOrEqual(1)
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

  it('rejects invalid snapshot files before import', async () => {
    const cache = new CacheStack([new MemoryLayer({ ttl: 60 })])
    const dir = await mkdtemp(join(tmpdir(), 'layercache-invalid-'))
    const filePath = join(dir, 'snapshot.json')

    try {
      await cache.persistToFile(filePath)
      await expect(readFile(filePath, 'utf8')).resolves.toContain('[')
      await writeFile(filePath, '{"bad":true}', 'utf8')
      await expect(cache.restoreFromFile(filePath)).rejects.toThrow(/Invalid snapshot file/i)
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
    await cache.set(
      'adaptive',
      { ok: true },
      {
        ttl: 10,
        adaptiveTtl: { hotAfter: 2, step: 5, maxTtl: 20 }
      }
    )

    const stored = await layer.getEntry<{ freshUntil?: number }>('adaptive')
    expect(stored).not.toBeNull()
    if (stored && typeof stored === 'object' && 'freshUntil' in stored) {
      const ttlSeconds = Math.round(((stored as { freshUntil: number }).freshUntil - Date.now()) / 1_000)
      expect(ttlSeconds).toBeGreaterThanOrEqual(14)
    }
  })

  it('refreshes sliding ttl across backfilled upper layers', async () => {
    const redis = new Redis()
    const memory = new MemoryLayer({ ttl: 60 })
    const redisLayer = new RedisLayer({ client: redis, ttl: 60, prefix: 'sliding:' })
    const cache = new CacheStack([memory, redisLayer])

    await cache.set('sliding:remote', { ok: true }, { ttl: 1 })
    await memory.delete('sliding:remote')
    await new Promise((resolve) => setTimeout(resolve, 700))

    await expect(cache.get('sliding:remote', undefined, { slidingTtl: true })).resolves.toEqual({ ok: true })
    await new Promise((resolve) => setTimeout(resolve, 700))

    await expect(memory.get('sliding:remote')).resolves.toEqual({ ok: true })
  })

  it('degrades unhealthy layers and opens circuit breakers for failing fetchers', async () => {
    const cache = new CacheStack([new ExplodingLayer(), new MemoryLayer({ ttl: 60 })], {
      gracefulDegradation: { retryAfterMs: 1_000 }
    })

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
    await handler(
      {},
      {
        setHeader: () => undefined,
        end: (chunk: string) => {
          body = chunk
        }
      }
    )

    expect(body).toContain('"sets": 1')
  })

  it('creates cache-backed method decorators', async () => {
    const cache = new CacheStack([new MemoryLayer({ ttl: 60 })])
    let executions = 0
    const wrapSpy = vi.spyOn(cache, 'wrap')

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
    expect(wrapSpy).toHaveBeenCalledTimes(1)
  })

  it('supports generation-based invalidation and prefix/tag batch invalidation', async () => {
    const cache = new CacheStack([new MemoryLayer({ ttl: 60 })], { generation: 1 })

    await cache.set('user:1', { id: 1 }, { tags: ['users', 'tenant:a'] })
    await cache.set('user:2', { id: 2 }, { tags: ['users'] })
    await cache.set('post:1', { id: 1 }, { tags: ['posts', 'tenant:a'] })

    await cache.invalidateByTags(['users', 'tenant:a'], 'all')
    await expect(cache.get('user:1')).resolves.toBeNull()
    await expect(cache.get('user:2')).resolves.toEqual({ id: 2 })

    await cache.invalidateByPrefix('post:')
    await expect(cache.get('post:1')).resolves.toBeNull()

    cache.bumpGeneration()
    await expect(cache.get('user:2')).resolves.toBeNull()
  })

  it('supports health checks and ttl policies', async () => {
    const cache = new CacheStack([new MemoryLayer({ ttl: 60 })])
    await cache.set('aligned', { ok: true }, { ttlPolicy: { alignTo: 60 } })

    const ttl = await cache.ttl('aligned')
    expect(ttl).toBeGreaterThan(0)

    const health = await cache.healthCheck()
    expect(health).toEqual([
      expect.objectContaining({
        layer: 'memory',
        healthy: true
      })
    ])
  })

  it('provides hono middleware and an OpenTelemetry plugin', async () => {
    const cache = new CacheStack([new MemoryLayer({ ttl: 60 })])
    const spans: Array<{ name: string; ended: boolean }> = []
    const tracer = {
      startSpan: (name: string) => {
        const span = { name, ended: false }
        spans.push(span)
        return {
          setAttribute: () => undefined,
          end: () => {
            span.ended = true
          }
        }
      }
    }

    const plugin = createOpenTelemetryPlugin(cache, tracer)
    await cache.set('otel:key', { ok: true })
    await cache.get('otel:key')
    plugin.uninstall()

    const middleware = createHonoCacheMiddleware(cache)
    const headers: Record<string, string> = {}
    let responseBody: unknown
    await middleware(
      {
        req: { method: 'GET', path: '/users' },
        header: (name, value) => {
          headers[name] = value
        },
        json: (body) => {
          responseBody = body
          return body
        }
      },
      async () => {
        responseBody = { ok: true }
      }
    )

    expect(spans.some((span) => span.name === 'layercache.get' && span.ended)).toBe(true)
    expect(responseBody).toEqual({ ok: true })
  })

  it('cleans access profiles on delete and clear', async () => {
    const cache = new CacheStack([new MemoryLayer({ ttl: 60 })])

    await cache.set('profile:1', { id: 1 })
    await cache.get('profile:1')
    // After delete the key should be gone from all layers
    await cache.delete('profile:1')
    expect(await cache.get('profile:1')).toBeNull()

    await cache.set('profile:2', { id: 2 })
    await cache.get('profile:2')
    await cache.clear()
    expect(await cache.get('profile:2')).toBeNull()
  })

  it('does not invoke tRPC next twice when the result is null', async () => {
    const cache = new CacheStack([new MemoryLayer({ ttl: 60 })])
    const middleware = createTrpcCacheMiddleware(cache, 'trpc')
    const next = vi.fn(async () => null as unknown as { ok: boolean; data?: null })

    await expect(
      middleware({
        path: 'user.get',
        type: 'query',
        rawInput: { id: 1 },
        next
      })
    ).resolves.toBeNull()

    expect(next).toHaveBeenCalledTimes(1)
  })
})
