import type Redis from 'ioredis'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { RedisLayer } from '../../../src/layers/RedisLayer'
import { TEST_PREFIX, createRedisClient, redisAvailable } from '../../integration-setup'

const describe_integration = describe.skipIf(!redisAvailable)

// RedisLayer behavior is covered by the mirrored unit tests in
// tests/layers/RedisLayer*.test.ts (real-redis-mirror project). This suite only
// keeps the scenario the mirror never exercises: waiting out a real TTL.
describe_integration('RedisLayer TTL (real Redis)', () => {
  let client: Redis
  let layer: RedisLayer
  const prefix = `${TEST_PREFIX}layer:`

  beforeAll(async () => {
    client = createRedisClient()
    await client.connect()
    layer = new RedisLayer({ client, prefix, ttl: 60_000 })
  })

  afterAll(async () => {
    await layer.clear()
    await client.disconnect()
  })

  it('respects TTL expiration', async () => {
    await layer.set('expiring', 'gone-soon', 1)
    await expect(layer.get('expiring')).resolves.toBe('gone-soon')

    await new Promise((resolve) => {
      setTimeout(resolve, 1_100)
    })

    await expect(layer.get('expiring')).resolves.toBeNull()
  })
})
