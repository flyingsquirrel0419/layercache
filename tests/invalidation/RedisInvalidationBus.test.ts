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
    await publisher.publish('layercache:test:invalid-payload', JSON.stringify({
      scope: 'key',
      sourceId: 'instance-a',
      keys: ['user:1'],
      operation: 'delete'
    }))

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

    await publisher.publish('layercache:test:handler-error', JSON.stringify({
      scope: 'key',
      sourceId: 'instance-a',
      keys: ['user:1'],
      operation: 'delete'
    }))
    await publisher.publish('layercache:test:handler-error', JSON.stringify({
      scope: 'clear',
      sourceId: 'instance-b',
      operation: 'clear'
    }))

    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(handler).toHaveBeenCalledTimes(2)
    expect(errorSpy).toHaveBeenCalled()

    await unsubscribe()
    publisher.disconnect()
    subscriber.disconnect()
  })

  it('prevents multiple active subscriptions on the same bus instance', async () => {
    const publisher = new Redis()
    const subscriber = publisher.duplicate()
    const bus = new RedisInvalidationBus({ publisher, subscriber, channel: 'layercache:test:duplicate-subscribe' })

    const unsubscribe = await bus.subscribe(() => undefined)

    await expect(bus.subscribe(() => undefined)).rejects.toThrow(/active subscription/i)

    await unsubscribe()
    publisher.disconnect()
    subscriber.disconnect()
  })
})
