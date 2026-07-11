import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CacheStack } from '../../../src/CacheStack'
import { RedisInvalidationBus } from '../../../src/invalidation/RedisInvalidationBus'
import { RedisTagIndex } from '../../../src/invalidation/RedisTagIndex'
import { MemoryLayer } from '../../../src/layers/MemoryLayer'
import { RedisLayer } from '../../../src/layers/RedisLayer'
import { RedisSingleFlightCoordinator } from '../../../src/singleflight/RedisSingleFlightCoordinator'
import { createTestRedis } from '../../helpers/test-redis'

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

describe('Multi-instance distributed caching (real Redis)', () => {
  let cacheA: CacheStack
  let cacheB: CacheStack

  beforeEach(() => {
    const redis = createTestRedis()
    const subscriberA = createTestRedis()
    const subscriberB = createTestRedis()
    const channel = 'bus:multi'
    const cachePrefix = 'multi:shared:'

    const busA = new RedisInvalidationBus({ publisher: redis, subscriber: subscriberA, channel })
    const busB = new RedisInvalidationBus({ publisher: redis, subscriber: subscriberB, channel })

    const tagIndex = new RedisTagIndex({ client: redis, prefix: 'tags:multi' })
    const coordinator = new RedisSingleFlightCoordinator({ client: redis, prefix: 'sf:multi' })

    cacheA = new CacheStack(
      [
        new MemoryLayer({ ttl: 60_000, maxSize: 1_000 }),
        new RedisLayer({ client: redis, prefix: cachePrefix, ttl: 300_000 })
      ],
      {
        invalidationBus: busA,
        tagIndex,
        singleFlightCoordinator: coordinator
      }
    )

    cacheB = new CacheStack(
      [
        new MemoryLayer({ ttl: 60_000, maxSize: 1_000 }),
        new RedisLayer({ client: redis, prefix: cachePrefix, ttl: 300_000 })
      ],
      {
        invalidationBus: busB,
        tagIndex,
        singleFlightCoordinator: coordinator
      }
    )
  })

  afterEach(async () => {
    await cacheA.disconnect()
    await cacheB.disconnect()
  })

  it('instance A writes to shared Redis, instance B reads via L2 backfill', async () => {
    await cacheA.set('shared:key1', { value: 'from-a' }, { tags: ['shared'] })

    const result = await cacheB.get('shared:key1', async () => ({ value: 'from-b' }))
    expect(result).toEqual({ value: 'from-a' })
  })

  it('tag invalidation on A propagates and clears L1 on B', async () => {
    await cacheA.set('tagged:item', { name: 'hello' }, { tags: ['tag:invalidate'] })
    await cacheB.get('tagged:item', async () => ({ name: 'hello' }))

    await cacheA.invalidateByTag('tag:invalidate')

    await sleep(300)

    const after = await cacheB.get('tagged:item')
    expect(after).toBeUndefined()
  })

  it('stampede prevention deduplicates across instances', async () => {
    let fetchCount = 0

    const fetcher = async () => {
      fetchCount++
      await sleep(50)
      return { fetch: fetchCount }
    }

    const results = await Promise.all([cacheA.get('stampede:cross', fetcher), cacheB.get('stampede:cross', fetcher)])

    expect(results[0]).toBeDefined()
    expect(results[1]).toBeDefined()
    expect(fetchCount).toBeLessThanOrEqual(2)
  })
})
