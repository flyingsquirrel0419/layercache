import { describe, expect, it, vi } from 'vitest'
import { MemoryLayer } from '../../src/layers/MemoryLayer'
import { createStoredValueEnvelope } from '../../src/internal/StoredValue'

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
})
