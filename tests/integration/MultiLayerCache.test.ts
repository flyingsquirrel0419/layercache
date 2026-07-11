import Redis from 'ioredis'
import { describe, expect, it } from 'vitest'
import { CacheStack } from '../../src/CacheStack'
import { MemoryLayer } from '../../src/layers/MemoryLayer'
import { RedisLayer } from '../../src/layers/RedisLayer'

describe('multi-layer integration', () => {
  it('fetches once and serves repeated hits from cache layers', async () => {
    const redis = new Redis()
    const cache = new CacheStack([new MemoryLayer({ ttl: 60_000 }), new RedisLayer({ client: redis, ttl: 300_000 })])

    let fetches = 0
    const first = await cache.get('profile:1', async () => {
      fetches += 1
      return { id: 1, role: 'admin' }
    })
    const second = await cache.get('profile:1', async () => {
      fetches += 1
      return { id: 1, role: 'admin' }
    })

    expect(first).toEqual({ id: 1, role: 'admin' })
    expect(second).toEqual({ id: 1, role: 'admin' })
    expect(fetches).toBe(1)
  })
})
