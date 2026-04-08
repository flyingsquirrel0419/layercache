import { describe, expect, it, vi } from 'vitest'
import { CacheStack } from '../src/CacheStack'
import { MemoryLayer } from '../src/layers/MemoryLayer'
import { CacheMissError } from '../src/types'
import { CacheNamespace } from '../src/CacheNamespace'

function makeCache() {
  return new CacheStack([new MemoryLayer({ ttl: 60 })])
}

describe('CacheNamespace', () => {
  it('qualifies keys with the prefix', async () => {
    const cache = makeCache()
    const ns = cache.namespace('users')
    await ns.set('123', { id: 123 })

    expect(await cache.get('users:123')).toEqual({ id: 123 })
    expect(await ns.get('123')).toEqual({ id: 123 })
  })

  it('qualify() returns prefixed key', () => {
    const ns = makeCache().namespace('posts')
    expect(ns.qualify('42')).toBe('posts:42')
  })

  it('rejects invalid top-level namespace prefixes', () => {
    const cache = makeCache()
    expect(() => cache.namespace('bad\u0000ns')).toThrow(/Namespace prefix/i)
  })

  it('delete removes the qualified key', async () => {
    const cache = makeCache()
    const ns = cache.namespace('orders')
    await ns.set('1', { total: 100 })
    await ns.delete('1')
    expect(await ns.get('1')).toBeNull()
  })

  it('mdelete removes multiple qualified keys', async () => {
    const cache = makeCache()
    const ns = cache.namespace('orders')
    await ns.set('1', 'a')
    await ns.set('2', 'b')
    await ns.mdelete(['1', '2'])
    expect(await ns.get('1')).toBeNull()
    expect(await ns.get('2')).toBeNull()
  })

  it('has() returns true when key exists', async () => {
    const ns = makeCache().namespace('items')
    await ns.set('x', 1)
    expect(await ns.has('x')).toBe(true)
    expect(await ns.has('y')).toBe(false)
  })

  it('ttl() returns remaining seconds', async () => {
    const ns = makeCache().namespace('items')
    await ns.set('k', 1, { ttl: 30 })
    const remaining = await ns.ttl('k')
    expect(remaining).toBeGreaterThan(0)
    expect(remaining).toBeLessThanOrEqual(30)
  })

  it('clear() only removes keys in this namespace', async () => {
    const cache = makeCache()
    const ns1 = cache.namespace('a')
    const ns2 = cache.namespace('b')
    await ns1.set('k', 1)
    await ns2.set('k', 2)
    await ns1.clear()
    expect(await ns1.get('k')).toBeNull()
    expect(await ns2.get('k')).toBe(2)
  })

  it('mget returns values for multiple keys', async () => {
    const ns = makeCache().namespace('data')
    await ns.set('a', 1)
    await ns.set('b', 2)
    const results = await ns.mget([{ key: 'a' }, { key: 'b' }, { key: 'c' }])
    expect(results).toEqual([1, 2, null])
  })

  it('mset stores multiple values', async () => {
    const ns = makeCache().namespace('data')
    await ns.mset([
      { key: 'x', value: 10 },
      { key: 'y', value: 20 }
    ])
    expect(await ns.get('x')).toBe(10)
    expect(await ns.get('y')).toBe(20)
  })

  it('wrap returns a cached function scoped to namespace', async () => {
    const ns = makeCache().namespace('fn')
    let calls = 0
    const cached = ns.wrap('compute', async (n: number) => {
      calls += 1
      return n * 2
    })

    expect(await cached(5)).toBe(10)
    expect(await cached(5)).toBe(10)
    expect(calls).toBe(1)
  })

  it('getOrSet stores and returns the fetched value', async () => {
    const ns = makeCache().namespace('cache')
    const result = await ns.getOrSet('key', async () => 42)
    expect(result).toBe(42)
    expect(await ns.get('key')).toBe(42)
    expect(ns.getMetrics().sets).toBeGreaterThanOrEqual(1)
  })

  it('getOrThrow participates in namespace metrics', async () => {
    const ns = makeCache().namespace('strict')
    await ns.set('key', 1)

    await expect(ns.getOrThrow('key')).resolves.toBe(1)
    expect(ns.getMetrics().hits).toBeGreaterThanOrEqual(1)
  })

  it('isolates tags between namespaces', async () => {
    const cache = makeCache()
    const tenantA = cache.namespace('tenant-a')
    const tenantB = cache.namespace('tenant-b')

    await tenantA.set('user:1', { id: 1 }, { tags: ['user'] })
    await tenantB.set('user:1', { id: 2 }, { tags: ['user'] })

    await tenantA.invalidateByTag('user')

    await expect(tenantA.get('user:1')).resolves.toBeNull()
    await expect(tenantB.get('user:1')).resolves.toEqual({ id: 2 })
  })

  it('strips namespace prefixes from inspect tags', async () => {
    const cache = makeCache()
    const ns = cache.namespace('tenant-a')

    await ns.set('user:1', { id: 1 }, { tags: ['user', 'profile'] })

    await expect(ns.inspect('user:1')).resolves.toEqual(
      expect.objectContaining({
        tags: ['user', 'profile']
      })
    )
  })

  it('does not serialize namespace metrics across different cache stacks', async () => {
    const nsA = makeCache().namespace('a')
    const nsB = makeCache().namespace('b')

    let releaseFetch!: () => void
    const fetchBlocked = new Promise<void>((resolve) => {
      releaseFetch = resolve
    })

    const first = nsA.getOrSet('key', async () => {
      await fetchBlocked
      return 1
    })

    await Promise.resolve()

    let secondCompleted = false
    const second = nsB.set('key', 2).then(() => {
      secondCompleted = true
    })

    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(secondCompleted).toBe(true)

    releaseFetch()
    await first
    await second
  })

  it('getMetrics proxies to the underlying stack', () => {
    const ns = makeCache().namespace('x')
    expect(ns.getMetrics()).toHaveProperty('hits')
  })

  it('getHitRate returns a valid snapshot', () => {
    const ns = makeCache().namespace('x')
    const hr = ns.getHitRate()
    expect(hr).toHaveProperty('overall')
    expect(hr).toHaveProperty('byLayer')
  })

  it('computes per-layer hit rates from namespace-local metrics', async () => {
    const ns = makeCache().namespace('rated')

    await ns.set('hit', 1)
    await ns.get('hit')
    await ns.get('miss')

    const hitRate = ns.getHitRate()
    expect(hitRate.overall).toBeGreaterThan(0)
    expect(hitRate.byLayer.memory).toBeGreaterThan(0)
  })

  it('supports nested namespaces plus invalidateByTags and invalidateByPattern', async () => {
    const cache = makeCache()
    const tenant = cache.namespace('tenant')
    const posts = tenant.namespace('posts')

    await posts.set('1', { id: 1 }, { tags: ['published', 'feed'] })
    await posts.set('2', { id: 2 }, { tags: ['draft'] })

    await posts.invalidateByTags(['published', 'feed'], 'all')
    await expect(posts.get('1')).resolves.toBeNull()
    await expect(posts.get('2')).resolves.toEqual({ id: 2 })

    await posts.invalidateByPattern('*')
    await expect(posts.get('2')).resolves.toBeNull()
  })

  it('supports invalidateByPrefix, warm, and inspect misses', async () => {
    const ns = makeCache().namespace('catalog')

    await ns.warm([{ key: 'top', fetcher: async () => ['sku-1'] }])
    await expect(ns.get('top')).resolves.toEqual(['sku-1'])
    await expect(ns.inspect('missing')).resolves.toBeNull()

    await ns.set('prefix:a', 1)
    await ns.set('prefix:b', 2)
    await ns.invalidateByPrefix('prefix:')
    await expect(ns.get('prefix:a')).resolves.toBeNull()
    await expect(ns.get('prefix:b')).resolves.toBeNull()
  })

  it('throws CacheMissError through namespace getOrThrow and validates prefixes', async () => {
    const ns = makeCache().namespace('strict')
    await expect(ns.getOrThrow('missing')).rejects.toBeInstanceOf(CacheMissError)

    expect(() => makeCache().namespace('')).toThrow(/must not be empty/i)
    expect(() => makeCache().namespace('x'.repeat(257))).toThrow(/at most 256/i)
    expect(() => makeCache().namespace('bad\uD800')).toThrow(/surrogate/i)
  })

  it('wrap qualifies tags and getMetrics returns cloned snapshots', async () => {
    const cache = makeCache()
    const ns = cache.namespace('tagged')
    let calls = 0
    const wrapped = ns.wrap('compute', async (id: number) => ({ id }), {
      tags: ['users'],
      keyResolver: (id) => String(id)
    })

    await wrapped(1)
    await ns.invalidateByTag('users')
    const wrappedAgain = ns.wrap(
      'compute',
      async (id: number) => {
        calls += 1
        return { id }
      },
      {
        tags: ['users'],
        keyResolver: (id) => String(id)
      }
    )
    await wrappedAgain(1)
    await wrappedAgain(1)
    expect(calls).toBe(1)

    const metrics = ns.getMetrics()
    metrics.hits = 999
    expect(ns.getMetrics().hits).not.toBe(999)
  })

  it('computes layer hit rates from collected namespace metrics', async () => {
    const cache = makeCache()
    const ns = cache.namespace('rates')
    await ns.set('key', 1)
    await ns.get('key')
    await ns.get('missing')

    const hitRate = ns.getHitRate()
    expect(hitRate.overall).toBeGreaterThan(0)
    expect(Object.keys(hitRate.byLayer).length).toBeGreaterThan(0)
  })

  it('serializes sibling namespace operations through the shared cache mutex', async () => {
    const metrics = {
      hits: 0,
      misses: 0,
      fetches: 0,
      sets: 0,
      deletes: 0,
      backfills: 0,
      invalidations: 0,
      staleHits: 0,
      refreshes: 0,
      refreshErrors: 0,
      writeFailures: 0,
      singleFlightWaits: 0,
      negativeCacheHits: 0,
      circuitBreakerTrips: 0,
      degradedOperations: 0,
      hitsByLayer: {},
      missesByLayer: {},
      latencyByLayer: {},
      resetAt: Date.now()
    }

    const calls: string[] = []
    let releaseFirst!: () => void
    const firstReleased = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })

    const cache = {
      getMetrics: vi.fn(() => metrics),
      getOrSet: vi.fn(async (key: string, fetcher: () => Promise<number>) => {
        calls.push(`getOrSet:${key}`)
        await firstReleased
        return fetcher()
      }),
      set: vi.fn(async (key: string, value: number) => {
        calls.push(`set:${key}:${value}`)
      })
    } as unknown as CacheStack

    const first = new CacheNamespace(cache, 'tenant-a')
    const second = new CacheNamespace(cache, 'tenant-b')

    const firstOperation = first.getOrSet('key', async () => 1)
    const secondOperation = second.set('key', 2)

    await Promise.resolve()
    await Promise.resolve()
    expect(calls).toEqual(['getOrSet:tenant-a:key'])

    releaseFirst()
    await expect(firstOperation).resolves.toBe(1)
    await expect(secondOperation).resolves.toBeUndefined()
    expect(calls).toEqual(['getOrSet:tenant-a:key', 'set:tenant-b:key:2'])
  })

  it('tracks zero-delta metrics snapshots and preserves zero-hit layer rates', async () => {
    const metrics = {
      hits: 0,
      misses: 0,
      fetches: 0,
      sets: 0,
      deletes: 0,
      backfills: 0,
      invalidations: 0,
      staleHits: 0,
      refreshes: 0,
      refreshErrors: 0,
      writeFailures: 0,
      singleFlightWaits: 0,
      negativeCacheHits: 0,
      circuitBreakerTrips: 0,
      degradedOperations: 0,
      hitsByLayer: { memory: 0 },
      missesByLayer: { memory: 0 },
      latencyByLayer: {},
      resetAt: Date.now()
    }

    const cache = {
      getMetrics: vi.fn(() => metrics),
      get: vi.fn(async () => null)
    } as unknown as CacheStack

    const ns = new CacheNamespace(cache, 'tenant')

    await expect(ns.get('key')).resolves.toBeNull()
    expect(cache.get).toHaveBeenCalledWith('tenant:key', undefined, undefined)
    expect(ns.getHitRate()).toEqual({
      overall: 0,
      byLayer: { memory: 0 }
    })
  })

  it('accumulates non-zero per-layer metrics from the wrapped cache', async () => {
    const snapshots = [
      {
        hits: 0,
        misses: 0,
        fetches: 0,
        sets: 0,
        deletes: 0,
        backfills: 0,
        invalidations: 0,
        staleHits: 0,
        refreshes: 0,
        refreshErrors: 0,
        writeFailures: 0,
        singleFlightWaits: 0,
        negativeCacheHits: 0,
        circuitBreakerTrips: 0,
        degradedOperations: 0,
        hitsByLayer: {},
        missesByLayer: {},
        latencyByLayer: {},
        resetAt: Date.now()
      },
      {
        hits: 1,
        misses: 0,
        fetches: 0,
        sets: 0,
        deletes: 0,
        backfills: 0,
        invalidations: 0,
        staleHits: 0,
        refreshes: 0,
        refreshErrors: 0,
        writeFailures: 0,
        singleFlightWaits: 0,
        negativeCacheHits: 0,
        circuitBreakerTrips: 0,
        degradedOperations: 0,
        hitsByLayer: { memory: 1 },
        missesByLayer: {},
        latencyByLayer: {},
        resetAt: Date.now()
      }
    ]

    let calls = 0
    const cache = {
      getMetrics: vi.fn(() => snapshots[Math.min(calls, snapshots.length - 1)]),
      get: vi.fn(async () => {
        calls += 1
        return null
      })
    } as unknown as CacheStack

    const ns = new CacheNamespace(cache, 'tenant')

    await expect(ns.get('key')).resolves.toBeNull()
    expect(ns.getMetrics().hitsByLayer.memory).toBe(1)
    expect(ns.getHitRate()).toEqual({
      overall: 1,
      byLayer: { memory: 1 }
    })
  })
})
