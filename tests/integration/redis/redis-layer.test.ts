import { describe, expect, it } from 'vitest'
import { RedisLayer } from '../../../src/layers/RedisLayer'
import { createTestRedis } from '../../helpers/test-redis'

// RedisLayer behavior is covered by the mirrored unit tests in
// tests/layers/RedisLayer*.test.ts (real-redis-mirror project). This suite only
// keeps the scenario the mirror never exercises: waiting out a real TTL.
describe('RedisLayer TTL (real Redis)', () => {
  it('respects TTL expiration', async () => {
    const client = createTestRedis()
    const layer = new RedisLayer({ client, prefix: 'layer:', ttl: 60_000 })

    await layer.set('expiring', 'gone-soon', 1)
    await expect(layer.get('expiring')).resolves.toBe('gone-soon')

    await new Promise((resolve) => {
      setTimeout(resolve, 1_100)
    })

    await expect(layer.get('expiring')).resolves.toBeNull()
  })
})
