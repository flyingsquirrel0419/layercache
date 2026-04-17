import type { CacheGetOptions } from '../types'

export const DANGEROUS_OBJECT_KEYS = new Set(['__proto__', 'prototype', 'constructor'])

function isPrimitive(value: unknown): value is string | number | boolean | null | undefined {
  return (
    value === null ||
    value === undefined ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  )
}

export function normalizeForSerialization(value: unknown): unknown {
  if (isPrimitive(value)) {
    return value
  }

  if (Array.isArray(value)) {
    const length = value.length
    let changed = false
    const mapped: unknown[] = new Array(length)
    for (let i = 0; i < length; i++) {
      const entry = value[i]
      if (isPrimitive(entry)) {
        mapped[i] = entry
      } else {
        changed = true
        mapped[i] = normalizeForSerialization(entry)
      }
    }
    return changed ? mapped : value
  }

  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>
    const keys = Object.keys(source)
    const length = keys.length

    let needsSort = false
    let needsFilter = false
    let needsRecurse = false

    for (let i = 0; i < length; i++) {
      const key = keys[i]
      if (key === undefined) continue
      if (DANGEROUS_OBJECT_KEYS.has(key)) {
        needsFilter = true
        continue
      }
      if (!isPrimitive(source[key])) {
        needsRecurse = true
      }
      const prev = keys[i - 1]
      if (i > 0 && prev !== undefined && prev > key) {
        needsSort = true
      }
    }

    if (!needsSort && !needsFilter && !needsRecurse) {
      return { ...source }
    }

    return keys.sort().reduce<Record<string, unknown>>((normalized, key) => {
      if (DANGEROUS_OBJECT_KEYS.has(key)) {
        return normalized
      }
      normalized[key] = normalizeForSerialization(source[key])
      return normalized
    }, {})
  }

  return value
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

  return `j:${JSON.stringify(normalizeForSerialization(value))}`
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
