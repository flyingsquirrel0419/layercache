import type Redis from 'ioredis'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { RedisTagIndex } from '../../../src/invalidation/RedisTagIndex'
import { TEST_PREFIX, createRedisClient, redisAvailable } from '../../integration-setup'

const describe_integration = describe.skipIf(!redisAvailable)

describe_integration('RedisTagIndex (real Redis)', () => {
  let client: Redis
  let index: RedisTagIndex
  const prefix = `${TEST_PREFIX}tags:`

  beforeAll(async () => {
    client = createRedisClient()
    await client.connect()
    index = new RedisTagIndex({ client, prefix })
  })

  afterAll(async () => {
    await index.clear()
    await client.disconnect()
  })

  it('tracks a key with tags and retrieves keys for a tag', async () => {
    await index.track('user:1', ['team:alpha', 'role:admin'])

    await expect(index.keysForTag('team:alpha')).resolves.toEqual(['user:1'])
    await expect(index.keysForTag('role:admin')).resolves.toEqual(['user:1'])
  })

  it('removes a key from the tag index', async () => {
    await index.track('user:2', ['team:beta'])
    await index.remove('user:2')

    await expect(index.keysForTag('team:beta')).resolves.toEqual([])
    await expect(index.tagsForKey('user:2')).resolves.toEqual([])
  })

  it('tracks multiple tags for one key', async () => {
    await index.track('user:3', ['team:gamma', 'role:viewer', 'region:us'])

    const tags = await index.tagsForKey('user:3')
    expect(tags.sort()).toEqual(['region:us', 'role:viewer', 'team:gamma'])

    await expect(index.keysForTag('team:gamma')).resolves.toEqual(['user:3'])
    await expect(index.keysForTag('region:us')).resolves.toEqual(['user:3'])
  })

  it('supports pattern matching on tracked keys', async () => {
    await index.track('product:100', ['category:electronics'])
    await index.track('product:200', ['category:books'])
    await index.track('user:400', ['category:electronics'])

    const productKeys = await index.matchPattern('product:*')
    expect(productKeys.sort()).toEqual(['product:100', 'product:200'])
  })

  it('clears all tracked data', async () => {
    await index.track('clear:1', ['tag:a'])
    await index.track('clear:2', ['tag:b'])

    await index.clear()

    await expect(index.keysForTag('tag:a')).resolves.toEqual([])
    await expect(index.keysForTag('tag:b')).resolves.toEqual([])
  })
})
