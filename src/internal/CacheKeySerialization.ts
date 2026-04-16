import type { CacheGetOptions } from '../types'

export const DANGEROUS_OBJECT_KEYS = new Set(['__proto__', 'prototype', 'constructor'])

export function normalizeForSerialization(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeForSerialization(entry))
  }

  if (value && typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((normalized, key) => {
        if (DANGEROUS_OBJECT_KEYS.has(key)) {
          return normalized
        }
        normalized[key] = normalizeForSerialization((value as Record<string, unknown>)[key])
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
