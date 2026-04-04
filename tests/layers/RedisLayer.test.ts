import Redis from 'ioredis-mock'
import { describe, expect, it } from 'vitest'
import { RedisLayer } from '../../src/layers/RedisLayer'
import { MsgpackSerializer } from '../../src/serialization/MsgpackSerializer'

describe('RedisLayer', () => {
  it('round-trips json values', async () => {
    const client = new Redis()
    const layer = new RedisLayer({ client, ttl: 60 })

    await layer.set('user:1', { id: 1, name: 'Alice' })

    await expect(layer.get('user:1')).resolves.toEqual({ id: 1, name: 'Alice' })
  })

  it('supports alternate serializers', async () => {
    const client = new Redis()
    const layer = new RedisLayer({ client, serializer: new MsgpackSerializer() })

    await layer.set('numbers', [1, 2, 3])

    await expect(layer.get('numbers')).resolves.toEqual([1, 2, 3])
  })

  it('treats deserialization failures as cache misses and removes the corrupted key', async () => {
    const client = new Redis()
    const layer = new RedisLayer({ client, serializer: new MsgpackSerializer() })

    await client.set('broken', 'not-msgpack')

    await expect(layer.get('broken')).resolves.toBeNull()
    await expect(client.get('broken')).resolves.toBeNull()
  })

  it('treats pipeline command errors and corrupted payloads as cache misses in bulk reads', async () => {
    const client = new Redis()
    const layer = new RedisLayer({ client, serializer: new MsgpackSerializer() })

    await layer.set('good', { ok: true })
    await client.set('broken', 'not-msgpack')
    await client.lpush('wrongtype', 'value')

    await expect(layer.getMany(['good', 'broken', 'wrongtype'])).resolves.toEqual([{ ok: true }, null, null])
    await expect(client.get('broken')).resolves.toBeNull()
  })

  it('refuses to clear an unprefixed redis namespace unless explicitly allowed', async () => {
    const client = new Redis()
    const layer = new RedisLayer({ client })

    await layer.set('user:1', { id: 1 })

    await expect(layer.clear()).rejects.toThrow(/requires a prefix or allowUnprefixedClear=true/i)
    await expect(layer.get('user:1')).resolves.toEqual({ id: 1 })
  })

  it('clears prefixed keys without touching other redis data', async () => {
    const client = new Redis()
    const prefixedLayer = new RedisLayer({ client, prefix: 'cache:' })
    const otherLayer = new RedisLayer({ client, prefix: 'other:' })

    await prefixedLayer.set('user:1', { id: 1 })
    await otherLayer.set('user:1', { id: 2 })

    await prefixedLayer.clear()

    await expect(prefixedLayer.get('user:1')).resolves.toBeNull()
    await expect(otherLayer.get('user:1')).resolves.toEqual({ id: 2 })
  })
})
