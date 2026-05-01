import { afterAll, beforeAll } from 'vitest'
import Redis from 'ioredis'

export const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379'
export const TEST_PREFIX = `layercache:test:${process.pid}:${Date.now()}:`
export const redisAvailable = process.env.REDIS_AVAILABLE === '1'

let cleanupClient: Redis | null = null

export function createRedisClient(): Redis {
  return new Redis(REDIS_URL, { lazyConnect: true })
}

beforeAll(async () => {
  if (redisAvailable) {
    cleanupClient = createRedisClient()
    await cleanupClient.connect()
  }
})

afterAll(async () => {
  if (!cleanupClient) {
    return
  }

  const pattern = `${TEST_PREFIX}*`
  let cursor = '0'

  do {
    const [nextCursor, keys] = await cleanupClient.scan(cursor, 'MATCH', pattern, 'COUNT', 200)
    cursor = nextCursor
    if (keys.length > 0) {
      await cleanupClient.del(...keys)
    }
  } while (cursor !== '0')

  await cleanupClient.disconnect()
  cleanupClient = null
})
