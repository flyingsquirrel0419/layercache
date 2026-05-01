import type Redis from 'ioredis'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CacheStack } from '../../../src/CacheStack'
import { RedisInvalidationBus } from '../../../src/invalidation/RedisInvalidationBus'
import { RedisTagIndex } from '../../../src/invalidation/RedisTagIndex'
import { MemoryLayer } from '../../../src/layers/MemoryLayer'
import { RedisLayer } from '../../../src/layers/RedisLayer'
import { RedisSingleFlightCoordinator } from '../../../src/singleflight/RedisSingleFlightCoordinator'
import { TEST_PREFIX, createRedisClient, redisAvailable } from '../../integration-setup'

const describe_integration = describe.skipIf(!redisAvailable)

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

describe_integration('Multi-instance distributed caching (real Redis)', () => {
  let redis: Redis
  let cacheA: CacheStack
  let cacheB: CacheStack
  let busA: RedisInvalidationBus
  let busB: RedisInvalidationBus
  const cachePrefix = `${TEST_PREFIX}multi:shared:`

  beforeAll(async () => {
    redis = createRedisClient()
    await redis.connect()

    const subscriberA = createRedisClient()
    await subscriberA.connect()
    const subscriberB = createRedisClient()
    await subscriberB.connect()

    const channel = `${TEST_PREFIX}bus:multi`

    busA = new RedisInvalidationBus({ publisher: redis, subscriber: subscriberA, channel })
    busB = new RedisInvalidationBus({ publisher: redis, subscriber: subscriberB, channel })

    const tagIndex = new RedisTagIndex({ client: redis, prefix: `${TEST_PREFIX}tags:multi` })
    const coordinator = new RedisSingleFlightCoordinator({ client: redis, prefix: `${TEST_PREFIX}sf:multi` })

    cacheA = new CacheStack(
      [
        new MemoryLayer({ ttl: 60, maxSize: 1_000 }),
        new RedisLayer({ client: redis, prefix: cachePrefix, ttl: 300 })
      ],
      {
        invalidationBus: busA,
        tagIndex,
        singleFlightCoordinator: coordinator
      }
    )

    cacheB = new CacheStack(
      [
        new MemoryLayer({ ttl: 60, maxSize: 1_000 }),
        new RedisLayer({ client: redis, prefix: cachePrefix, ttl: 300 })
      ],
      {
        invalidationBus: busB,
        tagIndex,
        singleFlightCoordinator: coordinator
      }
    )

    await Promise.all([cacheA.ready(), cacheB.ready()])
  })

  afterAll(async () => {
    await cacheA.disconnect()
    await cacheB.disconnect()
    await redis.disconnect()
  })

  it('instance A writes to shared Redis, instance B reads via L2 backfill', async () => {
    await cacheA.set('shared:key1', { value: 'from-a' }, { tags: ['shared'] })

    const result = await cacheB.get('shared:key1', () => ({ value: 'from-b' }))
    expect(result).toEqual({ value: 'from-a' })
  })

  it('tag invalidation on A propagates and clears L1 on B', async () => {
    await cacheA.set('tagged:item', { name: 'hello' }, { tags: ['tag:invalidate'] })
    await cacheB.get('tagged:item', () => ({ name: 'hello' }))

    await cacheA.invalidateByTag('tag:invalidate')

    await sleep(300)

    const after = await cacheB.get('tagged:item')
    expect(after).toBeNull()
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
