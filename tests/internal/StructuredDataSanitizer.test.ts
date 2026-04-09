import { describe, expect, it } from 'vitest'
import { sanitizeStructuredData } from '../../src/internal/StructuredDataSanitizer'

const defaultOptions = { label: 'Test', maxDepth: 64, maxNodes: 10_000 }

describe('sanitizeStructuredData', () => {
  it('passes through primitive values unchanged', () => {
    expect(sanitizeStructuredData('hello', defaultOptions)).toBe('hello')
    expect(sanitizeStructuredData(42, defaultOptions)).toBe(42)
    expect(sanitizeStructuredData(true, defaultOptions)).toBe(true)
    expect(sanitizeStructuredData(null, defaultOptions)).toBe(null)
  })

  it('passes through arrays with sanitized entries', () => {
    const input = ['a', 1, true, null]
    const result = sanitizeStructuredData(input, defaultOptions)
    expect(result).toEqual(['a', 1, true, null])
  })

  it('strips __proto__ keys from objects', () => {
    const input = { __proto__: { polluted: true }, safe: 'value' }
    const result = sanitizeStructuredData(input, defaultOptions) as Record<string, unknown>
    expect(result.safe).toBe('value')
    expect(result).not.toHaveProperty('__proto__')
    expect(result.polluted).toBeUndefined()
  })

  it('strips prototype keys from objects', () => {
    const input = { prototype: { polluted: true }, name: 'test' }
    const result = sanitizeStructuredData(input, defaultOptions) as Record<string, unknown>
    expect(result.name).toBe('test')
    expect(result).not.toHaveProperty('prototype')
  })

  it('strips constructor keys from objects', () => {
    const input = { constructor: 'malicious', data: 123 }
    const result = sanitizeStructuredData(input, defaultOptions) as Record<string, unknown>
    expect(result.data).toBe(123)
    expect(result).not.toHaveProperty('constructor')
  })

  it('strips dangerous keys in nested objects', () => {
    const input = {
      level1: {
        __proto__: { polluted: true },
        level2: { constructor: 'evil', valid: true }
      }
    }
    const result = sanitizeStructuredData(input, defaultOptions) as Record<string, unknown>
    expect((result.level1 as Record<string, unknown>).level2).toEqual({ valid: true })
    expect(result.level1 as Record<string, unknown>).not.toHaveProperty('__proto__')
  })

  it('strips dangerous keys in array elements', () => {
    const input = [{ __proto__: { polluted: true }, ok: 1 }, { safe: 2 }]
    const result = sanitizeStructuredData(input, defaultOptions) as Array<Record<string, unknown>>
    expect(result[0]).toEqual({ ok: 1 })
    expect(result[1]).toEqual({ safe: 2 })
  })

  it('uses createObject factory when provided', () => {
    const input = { a: 1 }
    let factoryCalled = false
    const result = sanitizeStructuredData(input, {
      ...defaultOptions,
      createObject: () => {
        factoryCalled = true
        return Object.create(null) as Record<string, unknown>
      }
    }) as Record<string, unknown>
    expect(result.a).toBe(1)
    expect(factoryCalled).toBe(true)
    expect(Object.getPrototypeOf(result)).toBeNull()
  })

  it('throws when maxDepth is exceeded', () => {
    const deep: Record<string, unknown> = { a: {} }
    let current = deep.a as Record<string, unknown>
    for (let index = 0; index < 65; index += 1) {
      current.n = {}
      current = current.n as Record<string, unknown>
    }

    expect(() => sanitizeStructuredData(deep, { ...defaultOptions, maxDepth: 10 })).toThrow(/max depth/i)
  })

  it('throws when maxNodes is exceeded', () => {
    const wide: Record<string, unknown> = {}
    for (let index = 0; index < 101; index += 1) {
      wide[`key${index}`] = index
    }

    expect(() => sanitizeStructuredData(wide, { ...defaultOptions, maxNodes: 50 })).toThrow(/max node count/i)
  })

  it('preserves normal object structure', () => {
    const input = {
      name: 'test',
      items: [1, 2, 3],
      nested: { deep: true }
    }
    expect(sanitizeStructuredData(input, defaultOptions)).toEqual({
      name: 'test',
      items: [1, 2, 3],
      nested: { deep: true }
    })
  })
})
