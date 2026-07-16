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
    expect(serializeKeyPart({ b: 2, a: 1, __proto__: { polluted: true } })).toBe('j2:{"a":1,"b":2}')
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

  it('preserves supported object identity and rejects unsupported object types', () => {
    expect(serializeKeyPart(new Date('2026-01-01T00:00:00.000Z'))).not.toBe(
      serializeKeyPart(new Date('2026-01-02T00:00:00.000Z'))
    )
    expect(serializeKeyPart(new Map([['tenant', 'alpha']]))).not.toBe(serializeKeyPart(new Map([['tenant', 'beta']])))

    class Tenant {
      constructor(readonly id: string) {}
    }
    expect(() => serializeKeyPart(new Tenant('alpha'))).toThrow(/unsupported cache-key object type/i)
  })

  it('canonicalizes supported built-ins and rejects unsafe key values', () => {
    expect(normalizeForSerialization(new URL('https://example.com/a?b=1'))).toEqual({
      $type: 'URL',
      value: 'https://example.com/a?b=1'
    })
    expect(normalizeForSerialization(/tenant:\d+/gi)).toEqual({
      $type: 'RegExp',
      source: 'tenant:\\d+',
      flags: 'gi'
    })
    expect(
      normalizeForSerialization(
        new Map([
          ['z', 1],
          ['a', 2]
        ])
      )
    ).toEqual({
      $type: 'Map',
      entries: [
        ['a', 2],
        ['z', 1]
      ]
    })
    expect(normalizeForSerialization(new Set(['z', 'a']))).toEqual({
      $type: 'Set',
      values: ['a', 'z']
    })
    expect(normalizeForSerialization(Object.assign(Object.create(null), { safe: true }))).toEqual({ safe: true })

    expect(() => normalizeForSerialization(new Date(Number.NaN))).toThrow(/invalid Date/i)
    expect(() => normalizeForSerialization(() => undefined)).toThrow(/function/i)
    expect(() => normalizeForSerialization(Symbol('tenant'))).toThrow(/symbol/i)
    expect(() => normalizeForSerialization(Object.create({ constructor: undefined }))).toThrow(/unknown/i)
    expect(() => normalizeForSerialization({ $type: 'Date', value: '2026-01-01T00:00:00.000Z' })).toThrow(
      /reserved cache-key type tag/i
    )
    expect(() =>
      normalizeForSerialization({
        nested: [{ $type: 'Map', entries: [] }]
      })
    ).toThrow(/reserved cache-key type tag/i)
  })

  it('rejects circular cache-key state', () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(() => serializeKeyPart(circular)).toThrow(/circular/i)
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
