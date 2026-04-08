import { describe, expect, it, vi } from 'vitest'
import { createStoredValueEnvelope } from '../../src/internal/StoredValue'
import { MemoryLayer } from '../../src/layers/MemoryLayer'

describe('MemoryLayer', () => {
  it('stores and retrieves values', async () => {
    const layer = new MemoryLayer({ ttl: 60 })
    await layer.set('user:1', { id: 1 })

    await expect(layer.get('user:1')).resolves.toEqual({ id: 1 })
  })

  it('expires values by ttl', async () => {
    vi.useFakeTimers()
    const layer = new MemoryLayer({ ttl: 1 })

    await layer.set('ephemeral', 'value')
    vi.advanceTimersByTime(1_001)

    await expect(layer.get('ephemeral')).resolves.toBeNull()
    vi.useRealTimers()
  })

  it('evicts least recently used entries', async () => {
    const layer = new MemoryLayer({ maxSize: 2 })
    await layer.set('a', 1)
    await layer.set('b', 2)
    await layer.get('a')
    await layer.set('c', 3)

    await expect(layer.get('b')).resolves.toBeNull()
    await expect(layer.get('a')).resolves.toBe(1)
    await expect(layer.get('c')).resolves.toBe(3)
  })

  it('returns raw stored entries from getMany for CacheStack fast paths', async () => {
    const layer = new MemoryLayer({ ttl: 60 })
    const envelope = createStoredValueEnvelope({ kind: 'value', value: { id: 1 }, freshTtlSeconds: 60 })

    await layer.set('user:1', envelope)

    await expect(layer.getMany(['user:1'])).resolves.toEqual([envelope])
    await expect(layer.get('user:1')).resolves.toEqual({ id: 1 })
  })

  it('supports interval cleanup and dispose', async () => {
    vi.useFakeTimers()
    const layer = new MemoryLayer({ ttl: 1, cleanupIntervalMs: 250 })

    await layer.set('ephemeral', 'value')
    vi.advanceTimersByTime(1_500)
    await Promise.resolve()

    await expect(layer.size()).resolves.toBe(0)

    await layer.dispose()
    vi.useRealTimers()
  })

  it('invokes onEvict when maxSize eviction happens', async () => {
    const onEvict = vi.fn()
    const layer = new MemoryLayer({ maxSize: 1, onEvict })

    await layer.set('a', 1)
    await layer.set('b', 2)

    expect(onEvict).toHaveBeenCalledWith('a', 1)
  })

  it('supports fifo and lfu eviction strategies', async () => {
    const fifo = new MemoryLayer({ maxSize: 2, evictionPolicy: 'fifo' })
    await fifo.set('a', 1)
    await fifo.set('b', 2)
    await fifo.get('a')
    await fifo.set('c', 3)
    await expect(fifo.get('a')).resolves.toBeNull()
    await expect(fifo.get('b')).resolves.toBe(2)

    const lfu = new MemoryLayer({ maxSize: 2, evictionPolicy: 'lfu' })
    await lfu.set('x', 1)
    await lfu.set('y', 2)
    await lfu.get('x')
    await lfu.get('x')
    await lfu.set('z', 3)
    await expect(lfu.get('y')).resolves.toBeNull()
    await expect(lfu.get('x')).resolves.toBe(1)
  })

  it('supports has ttl delete deleteMany keys forEachKey and ping', async () => {
    vi.useFakeTimers()
    const layer = new MemoryLayer({ ttl: 2 })
    await layer.set('a', 1)
    await layer.set('b', 2, 1)

    await expect(layer.has('a')).resolves.toBe(true)
    await expect(layer.ttl('a')).resolves.toBe(2)
    await expect(layer.ping()).resolves.toBe(true)

    const visited: string[] = []
    await layer.forEachKey((key) => {
      visited.push(key)
    })
    expect(visited).toEqual(['a', 'b'])
    await expect(layer.keys()).resolves.toEqual(['a', 'b'])

    vi.advanceTimersByTime(1_100)
    await expect(layer.has('b')).resolves.toBe(false)
    await expect(layer.ttl('b')).resolves.toBeNull()

    await layer.delete('a')
    await expect(layer.get('a')).resolves.toBeNull()

    await layer.set('c', 3)
    await layer.set('d', 4)
    await layer.deleteMany(['c', 'd'])
    await expect(layer.size()).resolves.toBe(0)
    vi.useRealTimers()
  })

  it('returns null ttl for non-expiring entries and removes expired entries during ttl lookups', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-07T00:00:00Z'))

    const layer = new MemoryLayer()
    await layer.set('permanent', 'value', 0)
    await expect(layer.ttl('permanent')).resolves.toBeNull()

    const expiring = new MemoryLayer({ ttl: 1 })
    await expiring.set('soon', 'value')
    vi.advanceTimersByTime(1_001)

    await expect(expiring.ttl('soon')).resolves.toBeNull()
    await expect(expiring.get('soon')).resolves.toBeNull()

    vi.useRealTimers()
  })

  it('imports and exports snapshot state while skipping expired entries', async () => {
    vi.useFakeTimers()
    const now = new Date('2026-04-07T00:00:00Z')
    vi.setSystemTime(now)

    const layer = new MemoryLayer({ maxSize: 3 })
    layer.importState([
      { key: 'fresh', value: { ok: true }, expiresAt: now.getTime() + 10_000 },
      { key: 'expired', value: { ok: false }, expiresAt: now.getTime() - 1_000 },
      { key: 'forever', value: 1, expiresAt: null }
    ])

    await expect(layer.get('fresh')).resolves.toEqual({ ok: true })
    await expect(layer.get('expired')).resolves.toBeNull()
    expect(layer.exportState()).toEqual([
      { key: 'forever', value: 1, expiresAt: null },
      { key: 'fresh', value: { ok: true }, expiresAt: now.getTime() + 10_000 }
    ])

    vi.useRealTimers()
  })

  it('evicts imported entries when snapshot size exceeds maxSize', async () => {
    vi.useFakeTimers()
    const now = new Date('2026-04-07T00:00:00Z')
    vi.setSystemTime(now)

    const layer = new MemoryLayer({ maxSize: 1 })
    layer.importState([
      { key: 'a', value: 1, expiresAt: now.getTime() + 10_000 },
      { key: 'b', value: 2, expiresAt: now.getTime() + 10_000 }
    ])

    await expect(layer.size()).resolves.toBe(1)
    await expect(layer.get('a')).resolves.toBeNull()
    await expect(layer.get('b')).resolves.toBe(2)

    vi.useRealTimers()
  })

  it('returns an empty bulk read for an empty key list', async () => {
    const layer = new MemoryLayer()
    await expect(layer.getMany([])).resolves.toEqual([])
  })
})
