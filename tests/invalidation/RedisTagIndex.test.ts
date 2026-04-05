import Redis from 'ioredis-mock'
import { describe, expect, it } from 'vitest'
import { RedisTagIndex } from '../../src/invalidation/RedisTagIndex'

describe('RedisTagIndex', () => {
  it('supports prefix scans over tracked keys', async () => {
    const redis = new Redis()
    const index = new RedisTagIndex({ client: redis, prefix: 'tags:test' })

    await index.touch('user:1')
    await index.touch('user:2')
    await index.touch('post:1')

    await expect(index.keysForPrefix('user:')).resolves.toEqual(['user:1', 'user:2'])
  })
})
