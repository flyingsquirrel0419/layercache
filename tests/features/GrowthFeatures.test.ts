import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
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

  it('serializes wrap() key parts with type prefixes to avoid collisions', async () => {
    const cache = new CacheStack([new MemoryLayer({ ttl: 60 })])
    let calls = 0
    const wrapped = cache.wrap('typed', async (value: string | number) => {
      calls += 1
      return { value, type: typeof value }
    })

    await expect(wrapped('1')).resolves.toEqual({ value: '1', type: 'string' })
    await expect(wrapped(1)).resolves.toEqual({ value: 1, type: 'number' })
    expect(calls).toBe(2)
  })

  it('supports snapshots on disk and export/import in memory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'layercache-'))
    const filePath = join(dir, 'snapshot.json')
    const first = new CacheStack([new MemoryLayer({ ttl: 60 })], { snapshotBaseDir: dir })
    await first.set('user:1', { id: 1 }, { ttl: 30 })

    const snapshot = await first.exportState()
    const second = new CacheStack([new MemoryLayer({ ttl: 60 })])
    await second.importState(snapshot)
    await expect(second.get('user:1')).resolves.toEqual({ id: 1 })

    try {
      await first.persistToFile(filePath)
      const third = new CacheStack([new MemoryLayer({ ttl: 60 })], { snapshotBaseDir: dir })
      await third.restoreFromFile(filePath)

      await expect(third.get('user:1')).resolves.toEqual({ id: 1 })
      await expect(readFile(filePath, 'utf8')).resolves.toContain('user:1')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('rejects snapshot exports that exceed snapshotMaxEntries', async () => {
    const cache = new CacheStack([new MemoryLayer({ ttl: 60 })], { snapshotMaxEntries: 1 })
    await cache.set('user:1', { id: 1 })
    await cache.set('user:2', { id: 2 })

    await expect(cache.exportState()).rejects.toThrow(/snapshotMaxEntries/i)
  })

  it('rejects invalid snapshot files before import', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'layercache-invalid-'))
    const filePath = join(dir, 'snapshot.json')
    const cache = new CacheStack([new MemoryLayer({ ttl: 60 })], { snapshotBaseDir: dir })

    try {
      await cache.persistToFile(filePath)
      await expect(readFile(filePath, 'utf8')).resolves.toContain('[')
      await writeFile(filePath, '{"bad":true}', 'utf8')
      await expect(cache.restoreFromFile(filePath)).rejects.toThrow(/Invalid snapshot file/i)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('rejects snapshot paths outside the allowed base directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'layercache-paths-'))
    const cache = new CacheStack([new MemoryLayer({ ttl: 60 })], { snapshotBaseDir: dir })
    const outsidePath = join(dir, '..', 'outside.json')

    try {
      await expect(cache.persistToFile(outsidePath)).rejects.toThrow(/outside the allowed snapshot directory/i)
      await expect(cache.restoreFromFile(outsidePath)).rejects.toThrow(/outside the allowed snapshot directory/i)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('sanitizes snapshot values before importing them back into the cache', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'layercache-snapshot-sanitize-'))
    const filePath = join(dir, 'snapshot.json')
    const cache = new CacheStack([new MemoryLayer({ ttl: 60 })], { snapshotBaseDir: dir })

    try {
      await writeFile(filePath, '[{"key":"user:1","value":{"safe":1,"__proto__":{"polluted":true}}}]', 'utf8')
      await cache.restoreFromFile(filePath)

      await expect(cache.get('user:1')).resolves.toEqual({ safe: 1 })
      expect({}.polluted).toBeUndefined()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('rejects snapshot values that exceed the JSON sanitization depth', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'layercache-snapshot-depth-'))
    const filePath = join(dir, 'snapshot.json')
    const cache = new CacheStack([new MemoryLayer({ ttl: 60 })], { snapshotBaseDir: dir })

    let nested: unknown = 'leaf'
    for (let index = 0; index < 220; index += 1) {
      nested = { value: nested }
    }

    try {
      await writeFile(filePath, JSON.stringify([{ key: 'user:1', value: nested }]), 'utf8')
      await expect(cache.restoreFromFile(filePath)).rejects.toThrow(/max depth/i)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('rejects oversized snapshot files before parsing them', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'layercache-snapshot-size-'))
    const filePath = join(dir, 'snapshot.json')
    const cache = new CacheStack([new MemoryLayer({ ttl: 60 })], {
      snapshotBaseDir: dir,
      snapshotMaxBytes: 32
    })

    try {
      await writeFile(filePath, JSON.stringify([{ key: 'user:1', value: 'x'.repeat(256) }]), 'utf8')
      await expect(cache.restoreFromFile(filePath)).rejects.toThrow(/snapshotMaxBytes/i)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('rejects snapshot entries with invalid cache keys before importing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'layercache-snapshot-invalid-key-'))
    const filePath = join(dir, 'snapshot.json')
    const cache = new CacheStack([new MemoryLayer({ ttl: 60 })], {
      snapshotBaseDir: dir
    })

    try {
      await writeFile(filePath, JSON.stringify([{ key: 'bad\u0000key', value: 1 }]), 'utf8')
      await expect(cache.restoreFromFile(filePath)).rejects.toThrow(/Cache key/i)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('rejects oversized snapshot files based on the opened file handle', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'layercache-snapshot-open-limit-'))
    const filePath = join(dir, 'snapshot.json')
    const cache = new CacheStack([new MemoryLayer({ ttl: 60 })], {
      snapshotBaseDir: dir,
      snapshotMaxBytes: 32
    })

    try {
      await writeFile(filePath, JSON.stringify([{ key: 'user:1', value: 'x'.repeat(256) }]), 'utf8')
      await expect(cache.restoreFromFile(filePath)).rejects.toThrow(/snapshotMaxBytes/i)
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

    const handler = createCacheStatsHandler(cache, { allowPublicAccess: true })
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

  it('rejects snapshot symlink escapes outside the allowed base directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'layercache-snapshot-link-'))
    const outsideDir = await mkdtemp(join(tmpdir(), 'layercache-snapshot-outside-'))
    const linkedDir = join(dir, 'linked')
    const linkedFile = join(linkedDir, 'snapshot.json')
    const outsideFile = join(outsideDir, 'snapshot.json')
    const cache = new CacheStack([new MemoryLayer({ ttl: 60 })], { snapshotBaseDir: dir })

    try {
      await mkdir(linkedDir, { recursive: true })
      await rm(linkedDir, { recursive: true, force: true })
      await symlink(outsideDir, linkedDir, 'dir')
      await writeFile(outsideFile, '[]', 'utf8')

      await expect(cache.persistToFile(linkedFile)).rejects.toThrow(/outside the allowed snapshot directory/i)
      await expect(cache.restoreFromFile(linkedFile)).rejects.toThrow(/outside the allowed snapshot directory/i)
    } finally {
      await rm(dir, { recursive: true, force: true })
      await rm(outsideDir, { recursive: true, force: true })
    }
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

  it('records OpenTelemetry exceptions and restores original methods on uninstall', async () => {
    const cache = new CacheStack([new MemoryLayer({ ttl: 60 })])
    const recordException = vi.fn()
    const setAttribute = vi.fn()
    const tracer = {
      startSpan: vi.fn(() => ({
        setAttribute,
        recordException,
        end: vi.fn()
      }))
    }

    const plugin = createOpenTelemetryPlugin(cache, tracer)

    await expect(
      cache.get('broken', async () => {
        throw new Error('boom')
      })
    ).rejects.toThrow('boom')

    expect(recordException).toHaveBeenCalled()
    expect(setAttribute).toHaveBeenCalledWith('layercache.success', false)

    plugin.uninstall()
    const spanCallsBefore = tracer.startSpan.mock.calls.length
    await cache.get('after-uninstall')
    expect(tracer.startSpan).toHaveBeenCalledTimes(spanCallsBefore)
  })

  it('records null OpenTelemetry results and instruments invalidation methods', async () => {
    const cache = new CacheStack([new MemoryLayer({ ttl: 60 })])
    const setAttribute = vi.fn()
    const tracer = {
      startSpan: vi.fn(() => ({
        setAttribute,
        recordException: vi.fn(),
        end: vi.fn()
      }))
    }

    const plugin = createOpenTelemetryPlugin(cache, tracer)
    await cache.get('missing')
    await cache.set('tagged', 1, { tags: ['group'] })
    await cache.invalidateByTag('group')
    plugin.uninstall()

    expect(setAttribute).toHaveBeenCalledWith('layercache.result', 'null')
    expect(tracer.startSpan).toHaveBeenCalledWith('layercache.invalidate_by_tag', expect.any(Object))
  })

  it('supports spans without optional methods and attaches key attributes to set/delete', async () => {
    const cache = new CacheStack([new MemoryLayer({ ttl: 60 })])
    const tracer = {
      startSpan: vi.fn(() => ({
        end: vi.fn()
      }))
    }

    const plugin = createOpenTelemetryPlugin(cache, tracer)
    await cache.set('otel:key', 1)
    await cache.delete('otel:key')
    plugin.uninstall()

    expect(tracer.startSpan).toHaveBeenCalledWith('layercache.set', {
      attributes: { 'layercache.key': 'otel:key' }
    })
    expect(tracer.startSpan).toHaveBeenCalledWith('layercache.delete', {
      attributes: { 'layercache.key': 'otel:key' }
    })
  })

  it('normalizes missing keys in OpenTelemetry key attributes', async () => {
    const cache = new CacheStack([new MemoryLayer({ ttl: 60 })])
    const tracer = {
      startSpan: vi.fn(() => ({
        setAttribute: vi.fn(),
        recordException: vi.fn(),
        end: vi.fn()
      }))
    }

    const plugin = createOpenTelemetryPlugin(cache, tracer)
    await expect((cache as { get: (key: undefined) => Promise<unknown> }).get(undefined)).rejects.toThrow()
    await expect(
      (cache as { set: (key: undefined, value: unknown) => Promise<void> }).set(undefined, 'value')
    ).rejects.toThrow()
    await expect((cache as { delete: (key: undefined) => Promise<void> }).delete(undefined)).rejects.toThrow()
    plugin.uninstall()

    expect(tracer.startSpan).toHaveBeenCalledWith('layercache.get', {
      attributes: { 'layercache.key': '' }
    })
    expect(tracer.startSpan).toHaveBeenCalledWith('layercache.set', {
      attributes: { 'layercache.key': '' }
    })
    expect(tracer.startSpan).toHaveBeenCalledWith('layercache.delete', {
      attributes: { 'layercache.key': '' }
    })
  })

  it('instruments bulk and pattern invalidation methods through the OpenTelemetry plugin', async () => {
    const cache = new CacheStack([new MemoryLayer({ ttl: 60 })])
    const tracer = {
      startSpan: vi.fn(() => ({
        setAttribute: vi.fn(),
        recordException: vi.fn(),
        end: vi.fn()
      }))
    }

    const plugin = createOpenTelemetryPlugin(cache, tracer)
    await cache.mset([
      { key: 'a', value: 1 },
      { key: 'b', value: 2 }
    ])
    await cache.mget([{ key: 'a' }, { key: 'b' }])
    await cache.invalidateByTags(['missing'], 'any')
    await cache.invalidateByPattern('user:*')
    await cache.invalidateByPrefix('user:')
    plugin.uninstall()

    expect(tracer.startSpan).toHaveBeenCalledWith('layercache.mset', { attributes: undefined })
    expect(tracer.startSpan).toHaveBeenCalledWith('layercache.mget', { attributes: undefined })
    expect(tracer.startSpan).toHaveBeenCalledWith('layercache.invalidate_by_tags', { attributes: undefined })
    expect(tracer.startSpan).toHaveBeenCalledWith('layercache.invalidate_by_pattern', { attributes: undefined })
    expect(tracer.startSpan).toHaveBeenCalledWith('layercache.invalidate_by_prefix', { attributes: undefined })
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
    const middleware = createTrpcCacheMiddleware(cache, 'trpc', {
      keyResolver: (input: { id: number }) => String(input.id)
    })
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
