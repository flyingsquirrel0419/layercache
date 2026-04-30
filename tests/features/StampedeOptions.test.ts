import { describe, expect, it } from 'vitest'
import { CacheStack } from '../../src/CacheStack'
import { MemoryLayer } from '../../src/layers/MemoryLayer'

describe('stampede options passthrough', () => {
  it('applies stampedeMaxInFlight to CacheStack fetches', async () => {
    const cache = new CacheStack([new MemoryLayer({ ttl: 60_000 })], {
      stampedeMaxInFlight: 1
    })

    let release!: () => void
    const first = cache.get('user:1', async () => {
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return { id: 1 }
    })

    await new Promise((resolve) => setTimeout(resolve, 0))

    await expect(
      cache.get('user:2', async () => ({
        id: 2
      }))
    ).rejects.toThrow(/in-flight limit/)

    release()
    await expect(first).resolves.toEqual({ id: 1 })
  })

  it('applies stampedeEntryTimeoutMs to CacheStack fetches and allows retry after timeout', async () => {
    const cache = new CacheStack([new MemoryLayer({ ttl: 60_000 })], {
      stampedeEntryTimeoutMs: 20
    })

    await expect(
      cache.get('slow:key', async () => {
        await new Promise((resolve) => setTimeout(resolve, 200))
        return 'late'
      })
    ).rejects.toThrow(/timed out/)

    await expect(cache.get('slow:key', async () => 'fresh')).resolves.toBe('fresh')
  })
})
