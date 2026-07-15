import { describe, expect, it } from 'vitest'
import { CacheStack } from '../../src/CacheStack'
import type { CacheLayer } from '../../src/types'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

class BlockingSetLayer implements CacheLayer {
  readonly name = 'blocking-set'
  readonly values = new Map<string, unknown>()
  readonly setStarted = deferred()
  readonly releaseSet = deferred()
  blockNextSet = true

  async get<T>(key: string): Promise<T | null> {
    return (this.values.get(key) as T | undefined) ?? null
  }

  async set(key: string, value: unknown): Promise<void> {
    if (this.blockNextSet) {
      this.blockNextSet = false
      this.setStarted.resolve()
      await this.releaseSet.promise
    }
    this.values.set(key, value)
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key)
  }

  async clear(): Promise<void> {
    this.values.clear()
  }
}

describe('invalidation race regressions', () => {
  it('removes an admitted backend write that commits after delete', async () => {
    const layer = new BlockingSetLayer()
    const cache = new CacheStack([layer])
    const write = cache.set('authorization:user-1', 'allowed')

    await layer.setStarted.promise
    await cache.delete('authorization:user-1')
    layer.releaseSet.resolve()
    await write

    await expect(cache.get('authorization:user-1')).resolves.toBeNull()
  })

  it('does not persist a foreground fetch completed after invalidation', async () => {
    const layer = new BlockingSetLayer()
    layer.blockNextSet = false
    const cache = new CacheStack([layer])
    const fetchStarted = deferred()
    const releaseFetch = deferred()
    const request = cache.get('authorization:user-2', async () => {
      fetchStarted.resolve()
      await releaseFetch.promise
      return 'allowed'
    })

    await fetchStarted.promise
    await cache.delete('authorization:user-2')
    releaseFetch.resolve()
    await expect(request).resolves.toBe('allowed')
    await expect(cache.get('authorization:user-2')).resolves.toBeNull()
  })
})
