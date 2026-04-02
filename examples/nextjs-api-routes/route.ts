import Redis from 'ioredis'
import { CacheBridge, MemoryLayer, RedisLayer } from '../../src'

const redis = new Redis(process.env.REDIS_URL)
const cache = new CacheBridge([
  new MemoryLayer({ ttl: 15 }),
  new RedisLayer({ client: redis, ttl: 120 })
])

export async function GET(_request: Request, context: { params: { id: string } }): Promise<Response> {
  const data = await cache.get(`user:${context.params.id}`, async () => {
    return {
      id: Number(context.params.id),
      cachedAt: new Date().toISOString()
    }
  })

  return Response.json(data)
}
