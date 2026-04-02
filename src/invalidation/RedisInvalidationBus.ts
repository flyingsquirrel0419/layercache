import type Redis from 'ioredis'
import type { InvalidationBus, InvalidationMessage } from '../types'

interface RedisInvalidationBusOptions {
  publisher: Redis
  subscriber?: Redis
  channel?: string
}

export class RedisInvalidationBus implements InvalidationBus {
  private readonly channel: string
  private readonly publisher: Redis
  private readonly subscriber: Redis

  constructor(options: RedisInvalidationBusOptions) {
    this.publisher = options.publisher
    this.subscriber = options.subscriber ?? options.publisher.duplicate()
    this.channel = options.channel ?? 'layercache:invalidation'
  }

  async subscribe(handler: (message: InvalidationMessage) => Promise<void> | void): Promise<() => Promise<void>> {
    const listener = async (_channel: string, payload: string): Promise<void> => {
      const message = JSON.parse(payload) as InvalidationMessage
      await handler(message)
    }

    this.subscriber.on('message', listener)
    await this.subscriber.subscribe(this.channel)

    return async () => {
      this.subscriber.off('message', listener)
      await this.subscriber.unsubscribe(this.channel)
    }
  }

  async publish(message: InvalidationMessage): Promise<void> {
    await this.publisher.publish(this.channel, JSON.stringify(message))
  }
}
