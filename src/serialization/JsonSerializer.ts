import type { CacheSerializer } from '../types'

const DANGEROUS_JSON_KEYS = new Set(['__proto__', 'prototype', 'constructor'])
const MAX_SANITIZE_NODES = 10_000

export class JsonSerializer implements CacheSerializer {
  serialize(value: unknown): string {
    return JSON.stringify(value)
  }

  deserialize<T>(payload: string | Buffer): T {
    const normalized = Buffer.isBuffer(payload) ? payload.toString('utf8') : payload
    return sanitizeJsonValue(JSON.parse(normalized), 0, { count: 0 }) as T
  }
}

const MAX_SANITIZE_DEPTH = 200

function sanitizeJsonValue(value: unknown, depth: number, state: { count: number }): unknown {
  state.count += 1
  if (state.count > MAX_SANITIZE_NODES) {
    throw new Error(`JSON payload exceeds max node count of ${MAX_SANITIZE_NODES}.`)
  }

  if (depth > MAX_SANITIZE_DEPTH) {
    throw new Error(`JSON payload exceeds max depth of ${MAX_SANITIZE_DEPTH}.`)
  }

  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeJsonValue(entry, depth + 1, state))
  }

  if (!isPlainObject(value)) {
    return value
  }

  const sanitized: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (DANGEROUS_JSON_KEYS.has(key)) {
      continue
    }

    sanitized[key] = sanitizeJsonValue(entry, depth + 1, state)
  }

  return sanitized
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Object.prototype.toString.call(value) === '[object Object]'
}
