import Redis from 'ioredis'
import { afterAll, beforeAll } from 'vitest'

export const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379'
export const TEST_PREFIX = `layercache:test:${process.pid}:${Date.now()}:`

let cleanupClient: Redis | null = null

export function createRedisClient(): Redis {
  return new Redis(REDIS_URL, { lazyConnect: true })
}

export let redisAvailable = false

beforeAll(async () => {
  const probe = createRedisClient()
  try {
    await probe.connect()
    await probe.ping()
    redisAvailable = true
  } catch {
    redisAvailable = false
  } finally {
    await probe.disconnect()
  }

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
