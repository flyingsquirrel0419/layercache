import { decode, encode } from '@msgpack/msgpack'
import type { CacheSerializer } from '../types'

const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor'])

export class MsgpackSerializer implements CacheSerializer {
  serialize(value: unknown): Buffer {
    return Buffer.from(encode(value))
  }

  deserialize<T>(payload: string | Buffer): T {
    const normalized = Buffer.isBuffer(payload) ? payload : Buffer.from(payload)
    return sanitizeMsgpackValue(decode(normalized)) as T
  }
}

function sanitizeMsgpackValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeMsgpackValue(entry))
  }

  if (!isPlainObject(value)) {
    return value
  }

  const sanitized: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (DANGEROUS_KEYS.has(key)) {
      continue
    }
    sanitized[key] = sanitizeMsgpackValue(entry)
  }

  return sanitized
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Object.prototype.toString.call(value) === '[object Object]'
}
