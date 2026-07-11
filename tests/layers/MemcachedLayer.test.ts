import { beforeEach, describe, expect, it } from 'vitest'
import { MemcachedLayer } from '../../src/layers/MemcachedLayer'
import type { MemcachedClient } from '../../src/layers/MemcachedLayer'
import { MsgpackSerializer } from '../../src/serialization/MsgpackSerializer'

/** Simple in-memory mock of the MemcachedClient interface. */
class MockMemcachedClient implements MemcachedClient {
  private store = new Map<string, { value: Buffer; expires?: number; setAt: number }>()

  async get(key: string): Promise<{ value: Buffer | null } | null> {
    const entry = this.store.get(key)
    if (!entry) {
      return null
    }
    if (entry.expires !== undefined && Date.now() > entry.setAt + entry.expires * 1_000) {
      this.store.delete(key)
      return null
    }
    return { value: entry.value }
  }

  async set(key: string, value: string | Buffer, options?: { expires?: number }): Promise<boolean> {
    const buf = typeof value === 'string' ? Buffer.from(value) : value
    this.store.set(key, { value: buf, expires: options?.expires, setAt: Date.now() })
    return true
  }

  async delete(key: string): Promise<boolean> {
    return this.store.delete(key)
  }
}

describe('MemcachedLayer', () => {
  let client: MockMemcachedClient
  let layer: MemcachedLayer

  beforeEach(() => {
    client = new MockMemcachedClient()
    layer = new MemcachedLayer({ client, ttl: 60_000 })
  })

  it('should set and get a value', async () => {
    await layer.set('key1', { hello: 'world' })
    const result = await layer.get<{ hello: string }>('key1')
    expect(result).toEqual({ hello: 'world' })
  })

  it('should return null for missing key', async () => {
    expect(await layer.get('missing')).toBeNull()
  })

  it('should delete a key', async () => {
    await layer.set('key1', 'val')
    await layer.delete('key1')
    expect(await layer.get('key1')).toBeNull()
  })

  it('should deleteMany', async () => {
    await layer.set('a', 1)
    await layer.set('b', 2)
    await layer.deleteMany(['a', 'b'])
    expect(await layer.get('a')).toBeNull()
    expect(await layer.get('b')).toBeNull()
  })

  it('should throw on clear()', async () => {
    await expect(layer.clear()).rejects.toThrow('MemcachedLayer.clear() is not supported')
  })

  it('should support getEntry for StoredValueEnvelope', async () => {
    const envelope = { __layercache: 1, kind: 'value', value: 42, freshUntil: null, staleUntil: null, errorUntil: null }
    await layer.set('env', envelope)
    const entry = await layer.getEntry('env')
    expect(entry).toHaveProperty('__layercache', 1)
  })

  it('should support has()', async () => {
    await layer.set('exists', true)
    expect(await layer.has('exists')).toBe(true)
    expect(await layer.has('nope')).toBe(false)
  })

  it('should support getMany', async () => {
    await layer.set('a', 1)
    await layer.set('b', 2)
    const results = await layer.getMany(['a', 'b', 'c'])
    expect(results).toHaveLength(3)
    expect(results[2]).toBeNull()
  })

  it('should use keyPrefix', async () => {
    const prefixed = new MemcachedLayer({ client, keyPrefix: 'app:', ttl: 60_000 })
    await prefixed.set('key1', 'value1')
    // Original client has the prefixed key
    const raw = await client.get('app:key1')
    expect(raw).not.toBeNull()
    // Unprefixed layer should not see it
    expect(await layer.get('key1')).toBeNull()
  })

  it('should use custom serializer', async () => {
    const msgpackLayer = new MemcachedLayer({
      client,
      serializer: new MsgpackSerializer(),
      ttl: 60_000
    })
    await msgpackLayer.set('key1', { foo: 'bar' })
    const result = await msgpackLayer.get<{ foo: string }>('key1')
    expect(result).toEqual({ foo: 'bar' })
  })

  it('should return null on deserialization error', async () => {
    // Write garbage directly to the mock
    await client.set('bad', 'not-valid-json!!!')
    const result = await layer.get('bad')
    expect(result).toBeNull()
    expect(await client.get('bad')).toBeNull()
  })

  it('still returns a miss when corrupt-entry cleanup fails', async () => {
    await client.set('bad', 'not-valid-json!!!')
    const originalDelete = client.delete.bind(client)
    client.delete = async () => {
      throw new Error('delete failed')
    }

    await expect(layer.get('bad')).resolves.toBeNull()
    client.delete = originalDelete
  })

  it('rejects keys that exceed the Memcached size limit', async () => {
    await expect(layer.set('x'.repeat(251), 'value')).rejects.toThrow(/250-byte Memcached limit/i)
  })

  it('rejects keys with whitespace or control characters', async () => {
    await expect(layer.delete('bad key')).rejects.toThrow(/invalid characters/i)
  })
})
