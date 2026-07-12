import { afterEach, describe, expect, it, vi } from 'vitest'
import { RedisInvalidationBus } from '../../src/invalidation/RedisInvalidationBus'
import { createTestRedis, realRedisTest } from '../helpers/test-redis'

describe('RedisInvalidationBus', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('skips malformed payloads and continues processing later messages', async () => {
    const publisher = createTestRedis()
    const subscriber = publisher.duplicate()
    const bus = new RedisInvalidationBus({ publisher, subscriber, channel: 'layercache:test:invalid-payload' })
    const handler = vi.fn()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const unsubscribe = await bus.subscribe(handler)

    await publisher.publish('layercache:test:invalid-payload', '{bad-json')
    await publisher.publish(
      'layercache:test:invalid-payload',
      JSON.stringify({
        scope: 'key',
        sourceId: 'instance-a',
        keys: ['user:1'],
        operation: 'delete'
      })
    )

    await vi.waitFor(() => {
      expect(handler).toHaveBeenCalledTimes(1)
      expect(errorSpy).toHaveBeenCalled()
    })

    await unsubscribe()
    publisher.disconnect()
    subscriber.disconnect()
  })

  it('warns when constructed without a signing secret', () => {
    const publisher = createTestRedis()
    const subscriber = publisher.duplicate()
    const logger = { warn: vi.fn() }

    new RedisInvalidationBus({ publisher, subscriber, channel: 'layercache:test:unsigned-warning', logger })

    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('without signingSecret'), {
      channel: 'layercache:test:unsigned-warning'
    })

    publisher.disconnect()
    subscriber.disconnect()
  })

  it('logs handler errors without breaking the subscription', async () => {
    const publisher = createTestRedis()
    const subscriber = publisher.duplicate()
    const bus = new RedisInvalidationBus({ publisher, subscriber, channel: 'layercache:test:handler-error' })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const handler = vi.fn(async () => {
      if (handler.mock.calls.length === 1) {
        throw new Error('listener failed')
      }
    })

    const unsubscribe = await bus.subscribe(handler)

    await publisher.publish(
      'layercache:test:handler-error',
      JSON.stringify({
        scope: 'key',
        sourceId: 'instance-a',
        keys: ['user:1'],
        operation: 'delete'
      })
    )
    await publisher.publish(
      'layercache:test:handler-error',
      JSON.stringify({
        scope: 'clear',
        sourceId: 'instance-b',
        operation: 'clear'
      })
    )

    await vi.waitFor(() => {
      expect(handler).toHaveBeenCalledTimes(2)
      expect(errorSpy).toHaveBeenCalled()
    })

    await unsubscribe()
    publisher.disconnect()
    subscriber.disconnect()
  })

  it('supports multiple concurrent subscriptions', async () => {
    const publisher = createTestRedis()
    const subscriber = publisher.duplicate()
    const bus = new RedisInvalidationBus({ publisher, subscriber, channel: 'layercache:test:multi-subscribe' })

    const handler1 = vi.fn()
    const handler2 = vi.fn()

    const unsub1 = await bus.subscribe(handler1)
    const unsub2 = await bus.subscribe(handler2)

    await publisher.publish(
      'layercache:test:multi-subscribe',
      JSON.stringify({ scope: 'key', sourceId: 'inst', keys: ['k'], operation: 'delete' })
    )

    await vi.waitFor(() => {
      expect(handler1).toHaveBeenCalledTimes(1)
      expect(handler2).toHaveBeenCalledTimes(1)
    })

    // Unsubscribing one handler should not affect the other
    await unsub1()

    await publisher.publish(
      'layercache:test:multi-subscribe',
      JSON.stringify({ scope: 'clear', sourceId: 'inst', operation: 'clear' })
    )

    await vi.waitFor(() => {
      expect(handler1).toHaveBeenCalledTimes(1) // no more calls
      expect(handler2).toHaveBeenCalledTimes(2)
    })

    await unsub2()
    publisher.disconnect()
    subscriber.disconnect()
  })

  it('uses the provided logger instead of console.error', async () => {
    const publisher = createTestRedis()
    const subscriber = publisher.duplicate()
    const logger = { error: vi.fn() }
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const bus = new RedisInvalidationBus({
      publisher,
      subscriber,
      channel: 'layercache:test:logger',
      logger
    })

    const unsubscribe = await bus.subscribe(async () => {
      throw new Error('boom')
    })

    await publisher.publish(
      'layercache:test:logger',
      JSON.stringify({ scope: 'key', sourceId: 'inst', keys: ['k'], operation: 'delete' })
    )

    await vi.waitFor(() => {
      expect(logger.error).toHaveBeenCalled()
      expect(consoleSpy).not.toHaveBeenCalled()
    })

    await unsubscribe()
    publisher.disconnect()
    subscriber.disconnect()
  })

  it('rejects excessively nested invalidation payloads before they reach handlers', async () => {
    const publisher = createTestRedis()
    const subscriber = publisher.duplicate()
    const logger = { error: vi.fn() }
    const bus = new RedisInvalidationBus({
      publisher,
      subscriber,
      channel: 'layercache:test:nested-payload',
      logger
    })
    const handler = vi.fn()

    const unsubscribe = await bus.subscribe(handler)

    let nested: unknown = 'leaf'
    for (let index = 0; index < 80; index += 1) {
      nested = { value: nested }
    }

    await publisher.publish(
      'layercache:test:nested-payload',
      JSON.stringify({
        scope: 'key',
        sourceId: 'inst',
        keys: ['user:1'],
        operation: 'delete',
        nested
      })
    )

    await vi.waitFor(() => {
      expect(handler).not.toHaveBeenCalled()
      expect(logger.error).toHaveBeenCalled()
    })

    await unsubscribe()
    publisher.disconnect()
    subscriber.disconnect()
  })

  it('rejects excessively wide invalidation payloads before they reach handlers', async () => {
    const publisher = createTestRedis()
    const subscriber = publisher.duplicate()
    const logger = { error: vi.fn() }
    const bus = new RedisInvalidationBus({
      publisher,
      subscriber,
      channel: 'layercache:test:wide-payload',
      logger
    })
    const handler = vi.fn()

    const unsubscribe = await bus.subscribe(handler)
    const keys = Array.from({ length: 10_500 }, (_, index) => `user:${index}`)

    await publisher.publish(
      'layercache:test:wide-payload',
      JSON.stringify({
        scope: 'keys',
        sourceId: 'inst',
        keys,
        operation: 'delete'
      })
    )

    await vi.waitFor(() => {
      expect(handler).not.toHaveBeenCalled()
      expect(logger.error).toHaveBeenCalled()
    })

    await unsubscribe()
    publisher.disconnect()
    subscriber.disconnect()
  })

  it('publishes through the bus API and rejects valid JSON with an invalid shape', async () => {
    const publisher = createTestRedis()
    const subscriber = publisher.duplicate()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const bus = new RedisInvalidationBus({ publisher, subscriber, channel: 'layercache:test:shape' })
    const handler = vi.fn()

    const unsubscribe = await bus.subscribe(handler)

    await bus.publish({ scope: 'key', sourceId: 'inst', keys: ['user:1'], operation: 'delete' })
    await publisher.publish('layercache:test:shape', JSON.stringify(42))

    await vi.waitFor(() => {
      expect(handler).toHaveBeenCalledTimes(1)
      expect(errorSpy).toHaveBeenCalled()
    })

    await unsubscribe()
    publisher.disconnect()
    subscriber.disconnect()
  })

  it('accepts expire operations and rejects unknown operations', async () => {
    const publisher = createTestRedis()
    const subscriber = publisher.duplicate()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const bus = new RedisInvalidationBus({ publisher, subscriber, channel: 'layercache:test:expire-op' })
    const handler = vi.fn()

    const unsubscribe = await bus.subscribe(handler)

    await publisher.publish(
      'layercache:test:expire-op',
      JSON.stringify({ scope: 'keys', sourceId: 'inst', keys: ['user:1'], operation: 'expire' })
    )
    await publisher.publish(
      'layercache:test:expire-op',
      JSON.stringify({ scope: 'keys', sourceId: 'inst', keys: ['user:2'], operation: 'unknown' })
    )

    await vi.waitFor(() => {
      expect(handler).toHaveBeenCalledTimes(1)
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: 'expire',
          keys: ['user:1']
        })
      )
      expect(errorSpy).toHaveBeenCalled()
    })

    await unsubscribe()
    publisher.disconnect()
    subscriber.disconnect()
  })

  it('accepts messages signed with the configured secret', async () => {
    const publisher = createTestRedis()
    const subscriber = publisher.duplicate()
    const channel = 'layercache:test:signed'
    const busA = new RedisInvalidationBus({ publisher, channel, signingSecret: 'shared-secret' })
    const busB = new RedisInvalidationBus({
      publisher,
      subscriber,
      channel,
      signingSecret: 'shared-secret'
    })
    const handler = vi.fn()

    const unsubscribe = await busB.subscribe(handler)

    await busA.publish({ scope: 'key', sourceId: 'inst', keys: ['user:1'], operation: 'delete' })

    await vi.waitFor(() => {
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          scope: 'key',
          keys: ['user:1'],
          operation: 'delete'
        })
      )
      expect(handler).toHaveBeenCalledTimes(1)
    })

    await unsubscribe()
    publisher.disconnect()
    subscriber.disconnect()
  })

  it('rejects unsigned messages when a signing secret is configured', async () => {
    const publisher = createTestRedis()
    const subscriber = publisher.duplicate()
    const logger = { error: vi.fn() }
    const channel = 'layercache:test:unsigned-rejected'
    const bus = new RedisInvalidationBus({ publisher, subscriber, channel, signingSecret: 'shared-secret', logger })
    const handler = vi.fn()

    const unsubscribe = await bus.subscribe(handler)

    await publisher.publish(
      channel,
      JSON.stringify({ scope: 'key', sourceId: 'inst', keys: ['user:1'], operation: 'delete' })
    )
    await vi.waitFor(() => {
      expect(handler).not.toHaveBeenCalled()
      expect(logger.error).toHaveBeenCalled()
    })

    await unsubscribe()
    publisher.disconnect()
    subscriber.disconnect()
  })

  it('rejects non-object signed envelopes when a signing secret is configured', async () => {
    const publisher = createTestRedis()
    const subscriber = publisher.duplicate()
    const logger = { error: vi.fn() }
    const channel = 'layercache:test:signed-non-object'
    const bus = new RedisInvalidationBus({ publisher, subscriber, channel, signingSecret: 'shared-secret', logger })
    const handler = vi.fn()

    const unsubscribe = await bus.subscribe(handler)

    await publisher.publish(channel, JSON.stringify(42))
    await vi.waitFor(() => {
      expect(handler).not.toHaveBeenCalled()
      expect(logger.error).toHaveBeenCalledWith('invalid invalidation payload', {
        error: expect.any(Error)
      })
    })

    await unsubscribe()
    publisher.disconnect()
    subscriber.disconnect()
  })

  it('keeps signing helper guarded when no signing secret is configured', () => {
    const publisher = createTestRedis()
    const subscriber = publisher.duplicate()
    const bus = new RedisInvalidationBus({ publisher, subscriber, channel: 'layercache:test:no-secret-helper' })

    expect(() => (bus as unknown as { createSignature: (payload: string) => string }).createSignature('{}')).toThrow(
      /signing key is not configured/i
    )

    publisher.disconnect()
    subscriber.disconnect()
  })

  it('rejects tampered signed messages', async () => {
    const publisher = createTestRedis()
    const subscriber = publisher.duplicate()
    const logger = { error: vi.fn() }
    const channel = 'layercache:test:tampered-signature'
    const bus = new RedisInvalidationBus({ publisher, subscriber, channel, signingSecret: 'shared-secret', logger })
    const handler = vi.fn()
    const publishSpy = vi.spyOn(publisher, 'publish')

    const unsubscribe = await bus.subscribe(handler)

    await bus.publish({ scope: 'key', sourceId: 'inst', keys: ['user:1'], operation: 'delete' })
    await vi.waitFor(() => {
      expect(handler).toHaveBeenCalledTimes(1)
    })

    const signedPayload = String(publishSpy.mock.calls[0]?.[1])
    const parsedPayload = JSON.parse(signedPayload) as {
      payload?: { keys?: string[] }
      signature?: string
    }
    const tampered =
      parsedPayload.payload && parsedPayload.signature
        ? { ...parsedPayload, payload: { ...parsedPayload.payload, keys: ['user:2'] } }
        : { scope: 'key', sourceId: 'inst', keys: ['user:2'], operation: 'delete' }
    handler.mockClear()
    logger.error.mockClear()

    await publisher.publish(channel, JSON.stringify(tampered))
    await vi.waitFor(() => {
      expect(handler).not.toHaveBeenCalled()
      expect(logger.error).toHaveBeenCalled()
    })

    await unsubscribe()
    publisher.disconnect()
    subscriber.disconnect()
  })

  realRedisTest.it('propagates messages across independent bus instances', async () => {
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
