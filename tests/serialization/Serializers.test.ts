import { encode } from '@msgpack/msgpack'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { JsonSerializer } from '../../src/serialization/JsonSerializer'
import { MsgpackSerializer } from '../../src/serialization/MsgpackSerializer'

describe('JsonSerializer', () => {
  const serializer = new JsonSerializer()

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('round-trips plain objects', () => {
    const value = { id: 1, name: 'alice', active: true }
    expect(serializer.deserialize(serializer.serialize(value))).toEqual(value)
  })

  it('round-trips arrays', () => {
    const value = [1, 'two', null, false]
    expect(serializer.deserialize(serializer.serialize(value))).toEqual(value)
  })

  it('round-trips primitives', () => {
    expect(serializer.deserialize(serializer.serialize(42))).toBe(42)
    expect(serializer.deserialize(serializer.serialize('hello'))).toBe('hello')
    expect(serializer.deserialize(serializer.serialize(null))).toBeNull()
    expect(serializer.deserialize(serializer.serialize(true))).toBe(true)
  })

  it('serializes to a string', () => {
    expect(typeof serializer.serialize({ a: 1 })).toBe('string')
  })

  it('throws on circular references', () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(() => serializer.serialize(circular)).toThrow()
  })

  it('strips prototype-pollution keys during deserialize', () => {
    const parsed = serializer.deserialize<Record<string, unknown>>('{"safe":1,"__proto__":{"polluted":true}}')
    expect(parsed).toEqual({ safe: 1 })
    expect({}.polluted).toBeUndefined()
  })

  it('rejects excessively nested payloads during deserialize', () => {
    let nested: unknown = 'leaf'
    for (let index = 0; index < 220; index += 1) {
      nested = { value: nested }
    }

    expect(() => serializer.deserialize(JSON.stringify(nested))).toThrow(/max depth/i)
  })

  it('rejects excessively wide payloads during deserialize', () => {
    const wide = Array.from({ length: 10_500 }, (_, index) => ({ [`k${index}`]: index }))
    expect(() => serializer.deserialize(JSON.stringify(wide))).toThrow(/max node count/i)
  })

  it('rejects oversized payloads before parsing', () => {
    const bounded = new JsonSerializer({ maxBytes: 8 })
    const parse = vi.spyOn(JSON, 'parse')
    expect(() => bounded.deserialize('{"value":1}')).toThrow(/maxBytes/i)
    expect(parse).not.toHaveBeenCalled()
  })

  it('surfaces non-Error JSON.parse failures with a stringified message', () => {
    vi.spyOn(JSON, 'parse').mockImplementation(() => {
      throw 'parse failed'
    })

    expect(() => serializer.deserialize('{"ok":true}')).toThrow(
      'JsonSerializer: failed to parse JSON payload: parse failed'
    )
  })
})

describe('MsgpackSerializer', () => {
  const serializer = new MsgpackSerializer()

  it('round-trips plain objects', () => {
    const value = { id: 2, name: 'bob', score: 99.5 }
    expect(serializer.deserialize(serializer.serialize(value))).toEqual(value)
  })

  it('round-trips arrays', () => {
    const value = [1, 2, 3, null, 'test']
    expect(serializer.deserialize(serializer.serialize(value))).toEqual(value)
  })

  it('round-trips primitives', () => {
    expect(serializer.deserialize(serializer.serialize(42))).toBe(42)
    expect(serializer.deserialize(serializer.serialize('hello'))).toBe('hello')
    expect(serializer.deserialize(serializer.serialize(null))).toBeNull()
    expect(serializer.deserialize(serializer.serialize(true))).toBe(true)
  })

  it('serializes to a Buffer', () => {
    expect(Buffer.isBuffer(serializer.serialize({ a: 1 }))).toBe(true)
  })

  it('produces smaller output than JSON for typical data', () => {
    const value = { id: 1, name: 'alice', tags: ['admin', 'user'], active: true }
    const jsonSize = JSON.stringify(value).length
    const msgpackSize = (serializer.serialize(value) as Buffer).byteLength
    expect(msgpackSize).toBeLessThan(jsonSize)
  })

  it('accepts string payloads for low-byte msgpack values', () => {
    const payload = serializer.serialize({ score: 128 }).toString('latin1')
    expect(serializer.deserialize(payload)).toEqual({ score: 128 })
  })

  it('strips dangerous prototype pollution keys during deserialize', () => {
    const payload = Buffer.from(encode(JSON.parse('{"safe":1,"prototype":"blocked","constructor":{"blocked":true}}')))

    expect(serializer.deserialize<Record<string, unknown>>(payload)).toEqual({ safe: 1 })
    expect(({} as Record<string, unknown> & { polluted?: boolean }).polluted).toBeUndefined()
  })

  it('rejects excessively nested payloads during deserialize', () => {
    let nested: unknown = 'leaf'
    for (let index = 0; index < 80; index += 1) {
      nested = { value: nested }
    }

    expect(() => serializer.deserialize(Buffer.from(encode(nested)))).toThrow(/max depth/i)
  })

  it('rejects excessively wide payloads during deserialize', () => {
    const wide = Array.from({ length: 10_500 }, (_, index) => ({ [`k${index}`]: index }))
    expect(() => serializer.deserialize(Buffer.from(encode(wide)))).toThrow(/max (?:node count|length)/i)
  })

  it('rejects oversized payloads before decoding', () => {
    const bounded = new MsgpackSerializer({ maxBytes: 4 })
    expect(() => bounded.deserialize(Buffer.from(encode({ value: 'too large' })))).toThrow(/maxBytes/i)
  })
})
