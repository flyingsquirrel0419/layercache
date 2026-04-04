import { describe, expect, it } from 'vitest'
import { JsonSerializer } from '../../src/serialization/JsonSerializer'
import { MsgpackSerializer } from '../../src/serialization/MsgpackSerializer'

describe('JsonSerializer', () => {
  const serializer = new JsonSerializer()

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
    circular['self'] = circular
    expect(() => serializer.serialize(circular)).toThrow()
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
})
