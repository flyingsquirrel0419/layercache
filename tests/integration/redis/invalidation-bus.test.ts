import { describe, expect, it, vi } from 'vitest'
import { RedisInvalidationBus } from '../../../src/invalidation/RedisInvalidationBus'
import { createTestRedis } from '../../helpers/test-redis'

// Single-connection bus behavior is covered by the mirrored unit tests in
// tests/invalidation/RedisInvalidationBus.test.ts (real-redis-mirror project).
// This suite only keeps the scenario the mirror cannot express: two fully
// independent connection pairs communicating through real pub/sub.
describe('RedisInvalidationBus (real Redis)', () => {
  it('propagates messages across independent bus instances', async () => {
    const publisher = createTestRedis()
    const subscriber = createTestRedis()
    const channel = 'bus:test'

    const busA = new RedisInvalidationBus({ publisher, subscriber: publisher.duplicate(), channel })
    const busB = new RedisInvalidationBus({
      publisher: subscriber,
      subscriber: subscriber.duplicate(),
      channel
    })

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
