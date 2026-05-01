import type Redis from 'ioredis'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { RedisInvalidationBus } from '../../../src/invalidation/RedisInvalidationBus'
import { TEST_PREFIX, createRedisClient, redisAvailable } from '../../integration-setup'

const describe_integration = describe.skipIf(!redisAvailable)

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

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

  it('delivers key invalidation from publisher to subscriber', async () => {
    const received: Array<Record<string, unknown>> = []

    const unsub = await busB.subscribe(async (message) => {
      received.push(message as Record<string, unknown>)
    })

    await busA.publish({ scope: 'key', sourceId: 'a', keys: ['user:1'], operation: 'delete' })

    await sleep(200)

    expect(received).toHaveLength(1)
    expect(received[0]).toMatchObject({
      scope: 'key',
      sourceId: 'a',
      keys: ['user:1'],
      operation: 'delete'
    })

    await unsub()
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

    await sleep(200)

    expect(receivedByA).toHaveLength(1)
    expect(receivedByB).toHaveLength(1)

    await unsubA()
    await unsubB()
  })

  it('propagates expire operations', async () => {
    const received: unknown[] = []

    const unsub = await busB.subscribe(async (msg) => {
      received.push(msg)
    })

    await busA.publish({
      scope: 'key',
      sourceId: 'a',
      keys: ['expiring-key'],
      operation: 'write'
    })

    await sleep(200)

    expect(received).toHaveLength(1)

    await unsub()
  })

  it('supports unsubscribe and stops receiving messages', async () => {
    const received: unknown[] = []

    const unsub = await busB.subscribe(async (msg) => {
      received.push(msg)
    })

    await busA.publish({ scope: 'clear', sourceId: 'a', operation: 'clear' })
    await sleep(200)
    expect(received).toHaveLength(1)

    await unsub()

    await busA.publish({ scope: 'clear', sourceId: 'a', operation: 'clear' })
    await sleep(200)
    expect(received).toHaveLength(1)
  })
})
