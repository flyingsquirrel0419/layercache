import type Redis from 'ioredis'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { RedisLayer } from '../../../src/layers/RedisLayer'
import { TEST_PREFIX, createRedisClient, redisAvailable } from '../../integration-setup'

const describe_integration = describe.skipIf(!redisAvailable)

describe_integration('RedisLayer (real Redis)', () => {
  let client: Redis
  let layer: RedisLayer
  const prefix = `${TEST_PREFIX}layer:`

  beforeAll(async () => {
    client = createRedisClient()
    await client.connect()
    layer = new RedisLayer({ client, prefix, ttl: 60_000 })
  })

  afterAll(async () => {
    await layer.clear()
    await client.disconnect()
  })

  it('round-trips values with set + get', async () => {
    await layer.set('user:1', { id: 1, name: 'Alice' })
    await expect(layer.get('user:1')).resolves.toEqual({ id: 1, name: 'Alice' })
  })

  it('returns null for missing keys', async () => {
    await expect(layer.get('nonexistent')).resolves.toBeNull()
  })

  it('deletes a key', async () => {
    await layer.set('temp', 'value')
    await layer.delete('temp')
    await expect(layer.get('temp')).resolves.toBeNull()
  })

  it('respects TTL expiration', async () => {
    await layer.set('expiring', 'gone-soon', 1)
    await expect(layer.get('expiring')).resolves.toBe('gone-soon')

    await new Promise((resolve) => {
      setTimeout(resolve, 1_100)
    })

    await expect(layer.get('expiring')).resolves.toBeNull()
  })

  it('round-trips with gzip compression', async () => {
    const gzipLayer = new RedisLayer({
      client,
      prefix: `${prefix}gzip:`,
      compression: 'gzip',
      compressionThreshold: 1
    })

    const payload = { data: 'x'.repeat(2_048) }
    await gzipLayer.set('compressed', payload)
    await expect(gzipLayer.get('compressed')).resolves.toEqual(payload)

    await gzipLayer.clear()
  })

  it('round-trips with brotli compression', async () => {
    const brotliLayer = new RedisLayer({
      client,
      prefix: `${prefix}brotli:`,
      compression: 'brotli',
      compressionThreshold: 1
    })

    const payload = { data: 'y'.repeat(2_048) }
    await brotliLayer.set('compressed', payload)
    await expect(brotliLayer.get('compressed')).resolves.toEqual(payload)

    await brotliLayer.clear()
  })

  it('handles setMany + getMany bulk operations', async () => {
    await layer.setMany([
      { key: 'bulk:a', value: 1, ttl: 60_000 },
      { key: 'bulk:b', value: 2 }
    ])

    await expect(layer.getMany(['bulk:a', 'bulk:b', 'bulk:c'])).resolves.toEqual([1, 2, null])
  })

  it('clear removes all prefixed keys', async () => {
    await layer.set('clear-test:1', 'a')
    await layer.set('clear-test:2', 'b')

    await layer.clear()

    await expect(layer.get('clear-test:1')).resolves.toBeNull()
    await expect(layer.get('clear-test:2')).resolves.toBeNull()
  })

  it('ping returns true when connected', async () => {
    await expect(layer.ping()).resolves.toBe(true)
  })
})
