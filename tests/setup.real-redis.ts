import type Redis from 'ioredis'
import { afterAll, afterEach, beforeAll } from 'vitest'
import { createRealControlClient, disconnectAllTestRedis } from './helpers/test-redis'

let controlClient: Redis | null = null

beforeAll(async () => {
  if (process.env.REDIS_AVAILABLE !== '1') {
    throw new Error(
      'The real-redis mirror project needs a running Redis. Run `npm run test:integration` ' +
        '(starts docker compose) or set REDIS_AVAILABLE=1 and REDIS_URL.'
    )
  }

  controlClient = createRealControlClient()
  // ioredis-mock gives each test file a fresh keyspace that is shared between
  // instances and persists across tests within the file. Mirror that exactly:
  // flush the worker db once per file, never per test.
  await controlClient.flushdb()
})

afterEach(() => {
  disconnectAllTestRedis()
})

afterAll(async () => {
  if (!controlClient) {
    return
  }

  try {
    await controlClient.flushdb()
  } catch {
    // Best-effort cleanup.
  }

  controlClient.disconnect()
  controlClient = null
})
