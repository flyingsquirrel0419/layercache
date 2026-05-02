import { decode, encode } from '@msgpack/msgpack'
import { sanitizeStructuredData } from '../internal/StructuredDataSanitizer'
import type { CacheSerializer } from '../types'

export class MsgpackSerializer implements CacheSerializer {
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
    return sanitizeStructuredData(decode(normalized), {
      label: 'MessagePack payload',
      maxDepth: 64,
      maxNodes: 10_000
    }) as T
  }
}
