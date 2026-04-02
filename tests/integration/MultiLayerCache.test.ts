import Redis from 'ioredis-mock'
import { describe, expect, it } from 'vitest'
import { CacheBridge } from '../../src/CacheBridge'
import { MemoryLayer } from '../../src/layers/MemoryLayer'
import { RedisLayer } from '../../src/layers/RedisLayer'

describe('multi-layer integration', () => {
  it('fetches once and serves repeated hits from cache layers', async () => {
    const redis = new Redis()
    const cache = new CacheBridge([
      new MemoryLayer({ ttl: 60 }),
      new RedisLayer({ client: redis, ttl: 300 })
    ])

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
