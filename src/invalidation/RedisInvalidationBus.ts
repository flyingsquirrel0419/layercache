import type Redis from 'ioredis'
import { sanitizeStructuredData } from '../internal/StructuredDataSanitizer'
import type { CacheLogger, InvalidationBus, InvalidationMessage } from '../types'

interface RedisInvalidationBusOptions {
  publisher: Redis
  subscriber?: Redis
  channel?: string
  logger?: CacheLogger
}

/**
 * Redis pub/sub invalidation bus.
 *
 * Supports multiple concurrent subscriptions — each `CacheStack` instance
 * can independently call `subscribe()` and receive its own unsubscribe handle.
 * The underlying Redis SUBSCRIBE is only issued once and shared across all handlers.
 */
export class RedisInvalidationBus implements InvalidationBus {
  private readonly channel: string
  private readonly publisher: Redis
  private readonly subscriber: Redis
  private readonly logger?: CacheLogger
  private readonly handlers = new Set<(message: InvalidationMessage) => Promise<void> | void>()
  private sharedListener?: (_channel: string, payload: string) => void
  private subscribePromise: Promise<void> | undefined

  constructor(options: RedisInvalidationBusOptions) {
    this.publisher = options.publisher
    this.subscriber = options.subscriber ?? options.publisher.duplicate()
    this.channel = options.channel ?? 'layercache:invalidation'
    this.logger = options.logger
  }

  async subscribe(handler: (message: InvalidationMessage) => Promise<void> | void): Promise<() => Promise<void>> {
    // Serialize concurrent subscribe() calls to prevent race conditions.
    // Chain onto the existing promise so late callers wait for earlier ones.
    const previousPromise = this.subscribePromise
    let resolveThis!: () => void
    this.subscribePromise = new Promise<void>((resolve) => {
      resolveThis = resolve
    })

    if (previousPromise) {
      await previousPromise
    }

    try {
      // First subscriber — attach to Redis
      if (this.handlers.size === 0) {
        const listener = (_channel: string, payload: string): void => {
          void this.dispatchToHandlers(payload)
        }
        this.sharedListener = listener
        this.subscriber.on('message', listener)
        await this.subscriber.subscribe(this.channel)
      }

      this.handlers.add(handler)
    } finally {
      resolveThis()
    }

    return async () => {
      this.handlers.delete(handler)

      // Last subscriber — detach from Redis
      if (this.handlers.size === 0 && this.sharedListener) {
        this.subscriber.off('message', this.sharedListener)
        this.sharedListener = undefined
        await this.subscriber.unsubscribe(this.channel)
      }
    }
  }

  async publish(message: InvalidationMessage): Promise<void> {
    await this.publisher.publish(this.channel, JSON.stringify(message))
  }

  private async dispatchToHandlers(payload: string): Promise<void> {
    let message: InvalidationMessage

    try {
      const parsed = sanitizeStructuredData(JSON.parse(payload), {
        label: 'Invalidation payload',
        maxDepth: 64,
        maxNodes: 10_000,
        createObject: () => Object.create(null) as Record<string, unknown>
      })
      if (!this.isInvalidationMessage(parsed)) {
        throw new Error('Invalid invalidation payload shape.')
      }
      message = parsed
    } catch (error) {
      this.reportError('invalid invalidation payload', error)
      return
    }

    await Promise.all(
      [...this.handlers].map(async (handler) => {
        try {
          await handler(message)
        } catch (error) {
          this.reportError('invalidation handler failed', error)
        }
      })
    )
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
      candidate.operation === 'expire' ||
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
    if (this.logger?.error) {
      this.logger.error(message, { error })
      return
    }

    console.error(`[layercache] ${message}`, error)
  }
}
