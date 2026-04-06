import type { CacheSerializer } from '../types'

const DANGEROUS_JSON_KEYS = new Set(['__proto__', 'prototype', 'constructor'])

export class JsonSerializer implements CacheSerializer {
  serialize(value: unknown): string {
    return JSON.stringify(value)
  }

  deserialize<T>(payload: string | Buffer): T {
    const normalized = Buffer.isBuffer(payload) ? payload.toString('utf8') : payload
    return sanitizeJsonValue(JSON.parse(normalized), 0) as T
  }
}

const MAX_SANITIZE_DEPTH = 200

function sanitizeJsonValue(value: unknown, depth: number): unknown {
  if (depth > MAX_SANITIZE_DEPTH) {
    return value
  }

  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeJsonValue(entry, depth + 1))
  }

  if (!isPlainObject(value)) {
    return value
  }

  const sanitized: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (DANGEROUS_JSON_KEYS.has(key)) {
      continue
    }

    sanitized[key] = sanitizeJsonValue(entry, depth + 1)
  }

  return sanitized
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Object.prototype.toString.call(value) === '[object Object]'
}
