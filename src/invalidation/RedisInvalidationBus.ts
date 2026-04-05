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
  private activeListener?: (_channel: string, payload: string) => void

  constructor(options: RedisInvalidationBusOptions) {
    this.publisher = options.publisher
    this.subscriber = options.subscriber ?? options.publisher.duplicate()
    this.channel = options.channel ?? 'layercache:invalidation'
  }

  async subscribe(handler: (message: InvalidationMessage) => Promise<void> | void): Promise<() => Promise<void>> {
    if (this.activeListener) {
      throw new Error('RedisInvalidationBus already has an active subscription.')
    }

    const listener = (_channel: string, payload: string): void => {
      void this.handleMessage(payload, handler)
    }

    this.activeListener = listener
    this.subscriber.on('message', listener)
    await this.subscriber.subscribe(this.channel)

    return async () => {
      if (this.activeListener !== listener) {
        return
      }

      this.activeListener = undefined
      this.subscriber.off('message', listener)
      await this.subscriber.unsubscribe(this.channel)
    }
  }

  async publish(message: InvalidationMessage): Promise<void> {
    await this.publisher.publish(this.channel, JSON.stringify(message))
  }

  private async handleMessage(
    payload: string,
    handler: (message: InvalidationMessage) => Promise<void> | void
  ): Promise<void> {
    let message: InvalidationMessage

    try {
      const parsed = JSON.parse(payload)
      if (!this.isInvalidationMessage(parsed)) {
        throw new Error('Invalid invalidation payload shape.')
      }
      message = parsed
    } catch (error) {
      this.reportError('invalid invalidation payload', error)
      return
    }

    try {
      await handler(message)
    } catch (error) {
      this.reportError('invalidation handler failed', error)
    }
  }

  private isInvalidationMessage(value: unknown): value is InvalidationMessage {
    if (!value || typeof value !== 'object') {
      return false
    }

    const candidate = value as Partial<InvalidationMessage>
    const validScope = candidate.scope === 'key' || candidate.scope === 'keys' || candidate.scope === 'clear'
    const validOperation =
      candidate.operation === undefined ||
      candidate.operation === 'write' ||
      candidate.operation === 'delete' ||
      candidate.operation === 'invalidate' ||
      candidate.operation === 'clear'
    const validKeys =
      candidate.keys === undefined ||
      (Array.isArray(candidate.keys) && candidate.keys.every((key) => typeof key === 'string'))

    return (
      validScope &&
      typeof candidate.sourceId === 'string' &&
      candidate.sourceId.length > 0 &&
      validOperation &&
      validKeys
    )
  }

  private reportError(message: string, error: unknown): void {
    console.error(`[layercache] ${message}`, error)
  }
}
