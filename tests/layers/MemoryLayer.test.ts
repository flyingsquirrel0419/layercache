import { describe, expect, it, vi } from 'vitest'
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
})
