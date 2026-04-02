import Redis from 'ioredis-mock'
import { CacheBridge, MemoryLayer, RedisLayer } from '../src'

async function main(): Promise<void> {
  const redis = new Redis()
  const cache = new CacheBridge([
    new MemoryLayer({ ttl: 60 }),
    new RedisLayer({ client: redis, ttl: 300 })
  ])

  let executions = 0

  await Promise.all(
    Array.from({ length: 100 }, () =>
      cache.get('stampede:key', async () => {
        executions += 1
        await new Promise((resolve) => setTimeout(resolve, 10))
        return { ok: true }
      })
    )
  )

  console.table({
    concurrentRequests: 100,
    fetcherExecutions: executions
  })
}

void main()
