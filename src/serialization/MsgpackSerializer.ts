import { decode, encode } from '@msgpack/msgpack'
import type { CacheSerializer } from '../types'

const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor'])
const MAX_SANITIZE_DEPTH = 64
const MAX_SANITIZE_NODES = 10_000

export class MsgpackSerializer implements CacheSerializer {
  serialize(value: unknown): Buffer {
    return Buffer.from(encode(value))
  }

  deserialize<T>(payload: string | Buffer): T {
    const normalized = Buffer.isBuffer(payload) ? payload : Buffer.from(payload)
    return sanitizeMsgpackValue(decode(normalized), 0, { count: 0 }) as T
  }
}

function sanitizeMsgpackValue(value: unknown, depth: number, state: { count: number }): unknown {
  state.count += 1
  if (state.count > MAX_SANITIZE_NODES) {
    throw new Error(`MessagePack payload exceeds max node count of ${MAX_SANITIZE_NODES}.`)
  }

  if (depth > MAX_SANITIZE_DEPTH) {
    throw new Error(`MessagePack payload exceeds max depth of ${MAX_SANITIZE_DEPTH}.`)
  }

  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeMsgpackValue(entry, depth + 1, state))
  }

  if (!isPlainObject(value)) {
    return value
  }

  const sanitized: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (DANGEROUS_KEYS.has(key)) {
      continue
    }
    sanitized[key] = sanitizeMsgpackValue(entry, depth + 1, state)
  }

  return sanitized
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Object.prototype.toString.call(value) === '[object Object]'
}
