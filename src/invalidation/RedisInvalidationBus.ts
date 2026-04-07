import type Redis from 'ioredis'
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

  constructor(options: RedisInvalidationBusOptions) {
    this.publisher = options.publisher
    this.subscriber = options.subscriber ?? options.publisher.duplicate()
    this.channel = options.channel ?? 'layercache:invalidation'
    this.logger = options.logger
  }

  async subscribe(handler: (message: InvalidationMessage) => Promise<void> | void): Promise<() => Promise<void>> {
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
      const parsed = sanitizeJsonValue(JSON.parse(payload))
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

const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor'])
const MAX_SANITIZE_DEPTH = 64
const MAX_SANITIZE_NODES = 10_000

function sanitizeJsonValue(value: unknown, depth = 0, state = { count: 0 }): unknown {
  state.count += 1
  if (state.count > MAX_SANITIZE_NODES) {
    throw new Error(`Invalidation payload exceeds max node count of ${MAX_SANITIZE_NODES}.`)
  }

  if (depth > MAX_SANITIZE_DEPTH) {
    throw new Error(`Invalidation payload exceeds max depth of ${MAX_SANITIZE_DEPTH}.`)
  }

  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeJsonValue(entry, depth + 1, state))
  }

  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = Object.create(null)
    for (const key of Object.keys(value as Record<string, unknown>)) {
      if (!DANGEROUS_KEYS.has(key)) {
        result[key] = sanitizeJsonValue((value as Record<string, unknown>)[key], depth + 1, state)
      }
    }
    return result
  }

  return value
}
