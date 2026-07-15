import { decode, encode } from '@msgpack/msgpack'
import { sanitizeStructuredData } from '../internal/StructuredDataSanitizer'
import type { CacheSerializer } from '../types'

const DEFAULT_MAX_BYTES = 4 * 1_024 * 1_024

export interface MsgpackSerializerOptions {
  maxBytes?: number
  maxDepth?: number
  maxNodes?: number
  maxContainerLength?: number
}

export class MsgpackSerializer implements CacheSerializer {
  private readonly maxBytes: number
  private readonly maxDepth: number
  private readonly maxNodes: number
  private readonly maxContainerLength: number

  constructor(options: MsgpackSerializerOptions = {}) {
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
    this.maxDepth = options.maxDepth ?? 64
    this.maxNodes = options.maxNodes ?? 10_000
    this.maxContainerLength = options.maxContainerLength ?? this.maxNodes
  }
  /**
   * Serializes a value to MessagePack bytes.
   */
  serialize(value: unknown): Buffer {
    return Buffer.from(encode(value))
  }

  /**
   * Decodes MessagePack bytes and sanitizes the result before returning it.
   */
  deserialize<T>(payload: string | Buffer): T {
    // latin1 preserves byte values 1:1 for binary msgpack payloads stored as strings
    const normalized = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'latin1')
    if (normalized.byteLength > this.maxBytes) {
      throw new Error(`MsgpackSerializer: payload size ${normalized.byteLength} exceeds maxBytes ${this.maxBytes}.`)
    }
    return sanitizeStructuredData(
      decode(normalized, {
        maxStrLength: this.maxBytes,
        maxBinLength: this.maxBytes,
        maxArrayLength: this.maxContainerLength,
        maxMapLength: this.maxContainerLength
      }),
      {
        label: 'MessagePack payload',
        maxDepth: this.maxDepth,
        maxNodes: this.maxNodes
      }
    ) as T
  }
}
