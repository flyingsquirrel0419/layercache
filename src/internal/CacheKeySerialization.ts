import type { CacheGetOptions } from '../types'

export const DANGEROUS_OBJECT_KEYS = new Set(['__proto__', 'prototype', 'constructor'])
const RESERVED_TYPE_TAGS = new Set(['Date', 'URL', 'RegExp', 'Map', 'Set'])

export function normalizeForSerialization(value: unknown): unknown {
  return normalizeValue(value, new WeakSet<object>())
}

function normalizeValue(value: unknown, ancestors: WeakSet<object>): unknown {
  if (Array.isArray(value)) {
    return withAncestor(value, ancestors, () => value.map((entry) => normalizeValue(entry, ancestors)))
  }

  if (value && typeof value === 'object') {
    if (value instanceof Date) {
      if (Number.isNaN(value.getTime())) throw new TypeError('Cannot serialize an invalid Date as a cache key.')
      return { $type: 'Date', value: value.toISOString() }
    }
    if (value instanceof URL) return { $type: 'URL', value: value.href }
    if (value instanceof RegExp) return { $type: 'RegExp', source: value.source, flags: value.flags }
    if (value instanceof Map) {
      return withAncestor(value, ancestors, () => ({
        $type: 'Map',
        entries: [...value.entries()]
          .map(([key, entry]) => [normalizeValue(key, ancestors), normalizeValue(entry, ancestors)])
          .sort(([left], [right]) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
      }))
    }
    if (value instanceof Set) {
      return withAncestor(value, ancestors, () => ({
        $type: 'Set',
        values: [...value].map((entry) => normalizeValue(entry, ancestors)).sort(compareNormalizedValues)
      }))
    }

    const prototype = Object.getPrototypeOf(value)
    const constructorName = prototype?.constructor?.name
    if (prototype !== null && constructorName !== 'Object') {
      throw new TypeError(`Unsupported cache-key object type: ${prototype?.constructor?.name ?? 'unknown'}.`)
    }

    const suppliedType = Object.hasOwn(value, '$type') ? (value as Record<string, unknown>).$type : undefined
    // Native values use these internal tags in the canonical form. Accepting
    // the same tags from plain objects would let different inputs share a key.
    if (typeof suppliedType === 'string' && RESERVED_TYPE_TAGS.has(suppliedType)) {
      throw new TypeError(`Reserved cache-key type tag: ${suppliedType}.`)
    }

    return withAncestor(value, ancestors, () =>
      Object.keys(value as Record<string, unknown>)
        .sort()
        .reduce<Record<string, unknown>>((normalized, key) => {
          if (DANGEROUS_OBJECT_KEYS.has(key)) return normalized
          normalized[key] = normalizeValue((value as Record<string, unknown>)[key], ancestors)
          return normalized
        }, {})
    )
  }

  if (typeof value === 'function' || typeof value === 'symbol') {
    throw new TypeError(`Unsupported cache-key value type: ${typeof value}.`)
  }

  return value
}

function withAncestor<T>(value: object, ancestors: WeakSet<object>, operation: () => T): T {
  if (ancestors.has(value)) throw new TypeError('Cannot serialize a circular value as a cache key.')
  ancestors.add(value)
  try {
    return operation()
  } finally {
    ancestors.delete(value)
  }
}

function compareNormalizedValues(left: unknown, right: unknown): number {
  return JSON.stringify(left).localeCompare(JSON.stringify(right))
}

export function serializeKeyPart(value: unknown): string {
  if (typeof value === 'string') {
    return `s:${value.replace(/%/g, '%25').replace(/:/g, '%3A')}`
  }

  if (typeof value === 'number') {
    return `n:${value}`
  }

  if (typeof value === 'boolean') {
    return `b:${value}`
  }

  return `j2:${JSON.stringify(normalizeForSerialization(value))}`
}

export function serializeOptions(options: CacheGetOptions | undefined): string {
  return JSON.stringify(normalizeForSerialization(options) ?? null)
}

export function createInstanceId(): string {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID()
  }

  if (globalThis.crypto?.getRandomValues) {
    const bytes = new Uint8Array(16)
    globalThis.crypto.getRandomValues(bytes)
    return `layercache-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`
  }

  throw new Error(
    'layercache requires a cryptographic random source. ' +
      'Neither crypto.randomUUID nor crypto.getRandomValues is available in this runtime.'
  )
}
