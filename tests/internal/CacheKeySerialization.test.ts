import { describe, expect, it, vi } from 'vitest'
import {
  createInstanceId,
  normalizeForSerialization,
  serializeKeyPart,
  serializeOptions
} from '../../src/internal/CacheKeySerialization'

describe('CacheKeySerialization', () => {
  it('serializes primitive and structured key parts with stable prefixes', () => {
    expect(serializeKeyPart('1')).toBe('s:1')
    expect(serializeKeyPart(1)).toBe('n:1')
    expect(serializeKeyPart(true)).toBe('b:true')
    expect(serializeKeyPart({ b: 2, a: 1, __proto__: { polluted: true } })).toBe('j:{"a":1,"b":2}')
  })

  it('normalizes nested structures and strips dangerous object keys', () => {
    expect(
      normalizeForSerialization({
        z: 1,
        constructor: 'drop',
        nested: [{ prototype: 'drop', safe: true }],
        a: { __proto__: 'drop', keep: 1 }
      })
    ).toEqual({
      a: { keep: 1 },
      nested: [{ safe: true }],
      z: 1
    })
  })

  it('serializes options through the normalizer', () => {
    expect(serializeOptions(undefined)).toBe('null')
    expect(serializeOptions({ tags: ['users'], shouldCache: undefined })).toContain('"tags":["users"]')
  })

  it('creates instance ids using randomUUID or getRandomValues, and throws when neither is available', () => {
    const originalCrypto = globalThis.crypto

    try {
      vi.stubGlobal('crypto', {
        randomUUID: () => 'uuid-value'
      })
      expect(createInstanceId()).toBe('uuid-value')

      vi.stubGlobal('crypto', {
        getRandomValues: (bytes: Uint8Array) => {
          bytes.fill(0xab)
          return bytes
        }
      })
      expect(createInstanceId()).toBe(`layercache-${'ab'.repeat(16)}`)

      vi.stubGlobal('crypto', undefined)
      expect(() => createInstanceId()).toThrow('layercache requires a cryptographic random source.')
    } finally {
      vi.unstubAllGlobals()
      vi.stubGlobal('crypto', originalCrypto)
    }
  })
})
