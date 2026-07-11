import type Redis from 'ioredis'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { RedisInvalidationBus } from '../../../src/invalidation/RedisInvalidationBus'
import { TEST_PREFIX, createRedisClient, redisAvailable } from '../../integration-setup'

const describe_integration = describe.skipIf(!redisAvailable)

// Single-connection bus behavior is covered by the mirrored unit tests in
// tests/invalidation/RedisInvalidationBus.test.ts (real-redis-mirror project).
// This suite only keeps the scenario the mirror cannot express: two fully
// independent connection pairs communicating through real pub/sub.
describe_integration('RedisInvalidationBus (real Redis)', () => {
  let publisher: Redis
  let subscriber: Redis
  let busA: RedisInvalidationBus
  let busB: RedisInvalidationBus
  const channel = `${TEST_PREFIX}bus:test`

  beforeAll(async () => {
    publisher = createRedisClient()
    subscriber = createRedisClient()
    await publisher.connect()
    await subscriber.connect()

    busA = new RedisInvalidationBus({ publisher, subscriber: publisher.duplicate(), channel })
    busB = new RedisInvalidationBus({
      publisher: subscriber,
      subscriber: subscriber.duplicate(),
      channel
    })
  })

  afterAll(async () => {
    await publisher.disconnect()
    await subscriber.disconnect()
  })

  it('propagates messages across independent bus instances', async () => {
    const receivedByA: unknown[] = []
    const receivedByB: unknown[] = []

    const unsubA = await busA.subscribe(async (msg) => {
      receivedByA.push(msg)
    })
    const unsubB = await busB.subscribe(async (msg) => {
      receivedByB.push(msg)
    })

    await busB.publish({ scope: 'keys', sourceId: 'b', keys: ['k1', 'k2'], operation: 'invalidate' })

    await vi.waitFor(() => {
      expect(receivedByA).toHaveLength(1)
      expect(receivedByB).toHaveLength(1)
    })

    await unsubA()
    await unsubB()
  })
})
