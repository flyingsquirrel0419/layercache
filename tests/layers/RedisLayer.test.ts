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
