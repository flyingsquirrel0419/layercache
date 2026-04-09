import { decode, encode } from '@msgpack/msgpack'
import { sanitizeStructuredData } from '../internal/StructuredDataSanitizer'
import type { CacheSerializer } from '../types'

export class MsgpackSerializer implements CacheSerializer {
  serialize(value: unknown): Buffer {
    return Buffer.from(encode(value))
  }

  deserialize<T>(payload: string | Buffer): T {
    const normalized = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'latin1')
    return sanitizeStructuredData(decode(normalized), {
      label: 'MessagePack payload',
      maxDepth: 64,
      maxNodes: 10_000
    }) as T
  }
}
