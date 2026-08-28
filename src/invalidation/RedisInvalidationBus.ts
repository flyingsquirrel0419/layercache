import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import type Redis from 'ioredis'
import { sanitizeStructuredData } from '../internal/StructuredDataSanitizer'
import type { CacheLogger, InvalidationBus, InvalidationMessage } from '../types'

interface RedisInvalidationBusOptions {
  /** Redis client used to publish invalidation messages. */
  publisher: Redis
  /** Redis client used for subscriptions. Defaults to `publisher.duplicate()`. */
  subscriber?: Redis
  /** Pub/sub channel name. Defaults to `layercache:invalidation`. */
  channel?: string
  /**
   * Shared secret used to sign and verify invalidation messages.
   * When configured, unsigned or invalidly signed messages are rejected.
   */
  signingSecret?: string | Buffer
  /**
   * Require a signing secret. When `true`, constructing the bus without a
   * `signingSecret` throws instead of silently running an unsigned channel
   * that any Redis publisher could forge messages on. Defaults to `false`.
   */
  requireSignature?: boolean
  /** Optional logger for invalid payloads or subscriber errors. */
  logger?: CacheLogger
}

interface SignedInvalidationEnvelope {
  payload: InvalidationMessage
  signature: string
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
  private readonly signingKey?: Buffer
  private readonly handlers = new Set<(message: InvalidationMessage) => Promise<void> | void>()
  private sharedListener?: (_channel: string, payload: string) => void
  private subscribePromise: Promise<void> | undefined

  constructor(options: RedisInvalidationBusOptions) {
    this.publisher = options.publisher
    this.channel = options.channel ?? 'layercache:invalidation'
    this.logger = options.logger

    const rawSecret = resolveSigningSecret(options.signingSecret)
    this.signingKey = rawSecret ? normalizeSigningSecret(rawSecret) : undefined

    if (!this.signingKey && options.requireSignature === true) {
      throw new Error(
        'RedisInvalidationBus requires a signingSecret when requireSignature=true. ' +
          'Without signing, any Redis publisher can forge invalidation messages on the channel.'
      )
    }

    this.subscriber = options.subscriber ?? options.publisher.duplicate()

    if (!this.signingKey) {
      this.logger?.warn?.(
        'RedisInvalidationBus is running without signingSecret; invalidation messages are unsigned. ' +
          'Any client that can publish to the channel can forge invalidation messages. ' +
          'Set signingSecret (or requireSignature=true) for shared or untrusted Redis channels.',
        {
          channel: this.channel
        }
      )
    }
  }

  /**
   * Subscribes to invalidation messages and returns an unsubscribe function.
   */
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

  /**
   * Publishes an invalidation message to other subscribers.
   */
  async publish(message: InvalidationMessage): Promise<void> {
    await this.publisher.publish(this.channel, JSON.stringify(this.signingKey ? this.signMessage(message) : message))
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
      const candidate = this.signingKey ? this.verifySignedEnvelope(parsed) : parsed
      if (!this.isInvalidationMessage(candidate)) {
        throw new Error('Invalid invalidation payload shape.')
      }
      message = candidate
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

  private signMessage(message: InvalidationMessage): SignedInvalidationEnvelope {
    const payload = JSON.stringify(message)
    return {
      payload: message,
      signature: this.createSignature(payload)
    }
  }

  private verifySignedEnvelope(value: unknown): InvalidationMessage {
    if (!value || typeof value !== 'object') {
      throw new Error('Signed invalidation envelope must be an object.')
    }

    const envelope = value as Partial<SignedInvalidationEnvelope>
    if (!envelope.payload || typeof envelope.payload !== 'object' || typeof envelope.signature !== 'string') {
      throw new Error('Signed invalidation envelope is missing payload or signature.')
    }

    const payload = JSON.stringify(envelope.payload)
    const expected = this.createSignature(payload)
    if (!isEqualSignature(envelope.signature, expected)) {
      throw new Error('Invalid invalidation message signature.')
    }

    return envelope.payload
  }

  private createSignature(payload: string): string {
    if (!this.signingKey) {
      throw new Error('RedisInvalidationBus signing key is not configured.')
    }

    return createHmac('sha256', this.signingKey).update(payload).digest('hex')
  }

  private reportError(message: string, error: unknown): void {
    if (this.logger?.error) {
      this.logger.error(message, { error })
      return
    }

    console.error(`[layercache] ${message}`, error)
  }
}

function normalizeSigningSecret(secret: string | Buffer): Buffer {
  const raw = Buffer.isBuffer(secret) ? secret : Buffer.from(secret, 'utf8')
  return createHash('sha256').update(raw).digest()
}

/** Treats zero-length strings and buffers as missing so they cannot pass as a configured secret. */
function resolveSigningSecret(secret: string | Buffer | undefined): string | Buffer | undefined {
  if (secret === undefined) {
    return undefined
  }
  if (Buffer.isBuffer(secret)) {
    return secret.byteLength > 0 ? secret : undefined
  }
  return secret.length > 0 ? secret : undefined
}

function isEqualSignature(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual, 'hex')
  const expectedBuffer = Buffer.from(expected, 'hex')
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer)
}
