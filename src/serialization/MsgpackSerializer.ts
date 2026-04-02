import { decode, encode } from '@msgpack/msgpack'
import type { CacheSerializer } from '../types'

export class MsgpackSerializer implements CacheSerializer {
  serialize(value: unknown): Buffer {
    return Buffer.from(encode(value))
  }

  deserialize<T>(payload: string | Buffer): T {
    const normalized = Buffer.isBuffer(payload) ? payload : Buffer.from(payload)
    return decode(normalized) as T
  }
}
