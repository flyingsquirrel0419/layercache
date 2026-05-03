import Redis from 'ioredis-mock'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RedisInvalidationBus } from '../../src/invalidation/RedisInvalidationBus'

describe('RedisInvalidationBus', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('skips malformed payloads and continues processing later messages', async () => {
    const publisher = new Redis()
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

    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(handler).toHaveBeenCalledTimes(1)
    expect(errorSpy).toHaveBeenCalled()

    await unsubscribe()
    publisher.disconnect()
    subscriber.disconnect()
  })

  it('logs handler errors without breaking the subscription', async () => {
    const publisher = new Redis()
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

    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(handler).toHaveBeenCalledTimes(2)
    expect(errorSpy).toHaveBeenCalled()

    await unsubscribe()
    publisher.disconnect()
    subscriber.disconnect()
  })

  it('supports multiple concurrent subscriptions', async () => {
    const publisher = new Redis()
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

    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(handler1).toHaveBeenCalledTimes(1)
    expect(handler2).toHaveBeenCalledTimes(1)

    // Unsubscribing one handler should not affect the other
    await unsub1()

    await publisher.publish(
      'layercache:test:multi-subscribe',
      JSON.stringify({ scope: 'clear', sourceId: 'inst', operation: 'clear' })
    )

    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(handler1).toHaveBeenCalledTimes(1) // no more calls
    expect(handler2).toHaveBeenCalledTimes(2)

    await unsub2()
    publisher.disconnect()
    subscriber.disconnect()
  })

  it('uses the provided logger instead of console.error', async () => {
    const publisher = new Redis()
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

    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(logger.error).toHaveBeenCalled()
    expect(consoleSpy).not.toHaveBeenCalled()

    await unsubscribe()
    publisher.disconnect()
    subscriber.disconnect()
  })

  it('rejects excessively nested invalidation payloads before they reach handlers', async () => {
    const publisher = new Redis()
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

    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(handler).not.toHaveBeenCalled()
    expect(logger.error).toHaveBeenCalled()

    await unsubscribe()
    publisher.disconnect()
    subscriber.disconnect()
  })

  it('rejects excessively wide invalidation payloads before they reach handlers', async () => {
    const publisher = new Redis()
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

    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(handler).not.toHaveBeenCalled()
    expect(logger.error).toHaveBeenCalled()

    await unsubscribe()
    publisher.disconnect()
    subscriber.disconnect()
  })

  it('publishes through the bus API and rejects valid JSON with an invalid shape', async () => {
    const publisher = new Redis()
    const subscriber = publisher.duplicate()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const bus = new RedisInvalidationBus({ publisher, subscriber, channel: 'layercache:test:shape' })
    const handler = vi.fn()

    const unsubscribe = await bus.subscribe(handler)

    await bus.publish({ scope: 'key', sourceId: 'inst', keys: ['user:1'], operation: 'delete' })
    await publisher.publish('layercache:test:shape', JSON.stringify(42))

    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(handler).toHaveBeenCalledTimes(1)
    expect(errorSpy).toHaveBeenCalled()

    await unsubscribe()
    publisher.disconnect()
    subscriber.disconnect()
  })

  it('accepts expire operations and rejects unknown operations', async () => {
    const publisher = new Redis()
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

    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'expire',
        keys: ['user:1']
      })
    )
    expect(errorSpy).toHaveBeenCalled()

    await unsubscribe()
    publisher.disconnect()
    subscriber.disconnect()
  })

  it('accepts messages signed with the configured secret', async () => {
    const publisher = new Redis()
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
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: 'key',
        keys: ['user:1'],
        operation: 'delete'
      })
    )

    await unsubscribe()
    publisher.disconnect()
    subscriber.disconnect()
  })

  it('rejects unsigned messages when a signing secret is configured', async () => {
    const publisher = new Redis()
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
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(handler).not.toHaveBeenCalled()
    expect(logger.error).toHaveBeenCalled()

    await unsubscribe()
    publisher.disconnect()
    subscriber.disconnect()
  })

  it('rejects tampered signed messages', async () => {
    const publisher = new Redis()
    const subscriber = publisher.duplicate()
    const logger = { error: vi.fn() }
    const channel = 'layercache:test:tampered-signature'
    const bus = new RedisInvalidationBus({ publisher, subscriber, channel, signingSecret: 'shared-secret', logger })
    const handler = vi.fn()
    const publishSpy = vi.spyOn(publisher, 'publish')

    const unsubscribe = await bus.subscribe(handler)

    await bus.publish({ scope: 'key', sourceId: 'inst', keys: ['user:1'], operation: 'delete' })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(handler).toHaveBeenCalledTimes(1)

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
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(handler).not.toHaveBeenCalled()
    expect(logger.error).toHaveBeenCalled()

    await unsubscribe()
    publisher.disconnect()
    subscriber.disconnect()
  })
})
