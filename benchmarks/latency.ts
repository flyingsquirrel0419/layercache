import { performance } from 'node:perf_hooks'
import Redis from 'ioredis-mock'
import { CacheStack, MemoryLayer, RedisLayer } from '../src'

async function main(): Promise<void> {
  const iterations = 5_000
  const redis = new Redis()
  const cache = new CacheStack([
    new MemoryLayer({ ttl: 60_000, maxSize: 10_000 }),
    new RedisLayer({ client: redis, ttl: 300_000 })
  ])

  await cache.set('bench:key', { ok: true })

  const memoryStart = performance.now()
  for (let index = 0; index < iterations; index += 1) {
    await cache.get('bench:key')
  }
  const memoryElapsed = performance.now() - memoryStart

  await redis.del('bench:key')
  await redis.set('bench:key', JSON.stringify({ ok: true }))

  const redisOnlyStart = performance.now()
  for (let index = 0; index < iterations; index += 1) {
    await cache.get('bench:key')
    await cache.delete('bench:key')
    await redis.set('bench:key', JSON.stringify({ ok: true }))
  }
  const redisOnlyElapsed = performance.now() - redisOnlyStart

  const noCacheStart = performance.now()
  for (let index = 0; index < iterations; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  const noCacheElapsed = performance.now() - noCacheStart

  console.table({
    l1MemoryAvgMs: memoryElapsed / iterations,
    l2RedisAvgMs: redisOnlyElapsed / iterations,
    noCacheAvgMs: noCacheElapsed / iterations
  })
}

void main()
