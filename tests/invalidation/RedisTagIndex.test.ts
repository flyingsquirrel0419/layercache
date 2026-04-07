import Redis from 'ioredis-mock'
import { describe, expect, it } from 'vitest'
import { RedisTagIndex } from '../../src/invalidation/RedisTagIndex'

describe('RedisTagIndex', () => {
  it('tracks tags, supports tag lookups, and removes reverse indexes', async () => {
    const redis = new Redis()
    const index = new RedisTagIndex({ client: redis, prefix: 'tags:track' })

    await index.track('user:1', ['team:a', 'role:admin'])
    await index.track('user:2', ['team:a'])

    await expect(index.keysForTag('team:a')).resolves.toEqual(['user:1', 'user:2'])
    await expect(index.tagsForKey('user:1')).resolves.toEqual(expect.arrayContaining(['role:admin', 'team:a']))

    await index.remove('user:1')
    await expect(index.keysForTag('team:a')).resolves.toEqual(['user:2'])
    await expect(index.tagsForKey('user:1')).resolves.toEqual([])
  })

  it('supports prefix scans over tracked keys', async () => {
    const redis = new Redis()
    const index = new RedisTagIndex({ client: redis, prefix: 'tags:test' })

    await index.touch('user:1')
    await index.touch('user:2')
    await index.touch('post:1')

    await expect(index.keysForPrefix('user:')).resolves.toEqual(['user:1', 'user:2'])
  })

  it('filters prefix scan results with startsWith for literal safety', async () => {
    const redis = new Redis()
    const index = new RedisTagIndex({ client: redis, prefix: 'tags:safe' })

    await index.touch('user[1]:a')
    await index.touch('user1:a')

    await expect(index.keysForPrefix('user[1]:')).resolves.toEqual(['user[1]:a'])
  })

  it('supports sharding the known-keys set for larger indexes', async () => {
    const redis = new Redis()
    const index = new RedisTagIndex({ client: redis, prefix: 'tags:sharded', knownKeysShards: 4 })

    await index.touch('user:1')
    await index.touch('user:2')
    await index.touch('post:1')

    await expect(index.keysForPrefix('user:')).resolves.toEqual(['user:1', 'user:2'])
  })

  it('supports pattern scans and async visitor helpers', async () => {
    const redis = new Redis()
    const index = new RedisTagIndex({ client: redis, prefix: 'tags:visitors', scanCount: 1 })

    await index.track('user:1', ['people'])
    await index.track('user:2', ['people'])
    await index.track('post:1', ['posts'])

    await expect(index.matchPattern('user:*')).resolves.toEqual(['user:1', 'user:2'])

    const byTag: string[] = []
    await index.forEachKeyForTag('people', async (key) => {
      byTag.push(key)
    })
    expect(byTag).toEqual(['user:1', 'user:2'])

    const byPrefix: string[] = []
    await index.forEachKeyForPrefix('user:', async (key) => {
      byPrefix.push(key)
    })
    expect(byPrefix).toEqual(['user:1', 'user:2'])

    const byPattern: string[] = []
    await index.forEachKeyMatchingPattern('post:*', async (key) => {
      byPattern.push(key)
    })
    expect(byPattern).toEqual(['post:1'])
  })

  it('clears all index keys and rejects invalid shard counts', async () => {
    const redis = new Redis()
    const index = new RedisTagIndex({ client: redis, prefix: 'tags:clear' })

    await index.track('user:1', ['team:a'])
    await index.touch('user:2')
    await index.clear()

    await expect(index.keysForPrefix('user:')).resolves.toEqual([])
    expect(() => new RedisTagIndex({ client: redis, knownKeysShards: 0 })).toThrow(/positive integer/i)
  })
})
