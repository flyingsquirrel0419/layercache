import { describe, expect, it } from 'vitest'
import { CacheStack } from '../src/CacheStack'
import { MemoryLayer } from '../src/layers/MemoryLayer'

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
})
