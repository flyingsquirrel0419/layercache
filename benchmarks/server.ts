import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http'

import type { Redis } from 'ioredis'
import { CacheStack, MemoryLayer, RedisLayer, RedisSingleFlightCoordinator } from '../src'
import { resolveBenchmarkFixturePath } from './paths'
import { createCountedFetcher } from './scenario-utils'
import { ensureFixtureFile, loadUserFromFixture } from './workload'

export interface BenchmarkServerHandle {
  port: number
  close: () => Promise<void>
  reset: () => Promise<void>
  warm: () => Promise<void>
}

const DEFAULT_USER_ID = 4242

function createOriginFetcher(filePath: string) {
  return createCountedFetcher(async (userId: number) => loadUserFromFixture(filePath, userId))
}

function respondJson(serverResponse: ServerResponse<IncomingMessage>, statusCode: number, payload: unknown): void {
  serverResponse.statusCode = statusCode
  serverResponse.setHeader('content-type', 'application/json')
  serverResponse.end(JSON.stringify(payload))
}

export async function startBenchmarkServer(redis: Redis): Promise<BenchmarkServerHandle> {
  const fixturePath = resolveBenchmarkFixturePath()
  await ensureFixtureFile(fixturePath)

  const memoryCache = new CacheStack([new MemoryLayer({ ttl: 60, maxSize: 2_000 })], {
    stampedePrevention: true
  })

  const layeredCache = new CacheStack(
    [
      new MemoryLayer({ ttl: 60, maxSize: 2_000 }),
      new RedisLayer({ client: redis, ttl: 300, prefix: 'layercache-bench:http:' })
    ],
    {
      stampedePrevention: true,
      singleFlightCoordinator: new RedisSingleFlightCoordinator({
        client: redis,
        prefix: 'layercache-bench:http:single-flight:'
      })
    }
  )

  const gracefulLayeredCache = new CacheStack(
    [
      new MemoryLayer({ ttl: 60, maxSize: 2_000 }),
      new RedisLayer({ client: redis, ttl: 300, prefix: 'layercache-bench:http:graceful:' })
    ],
    {
      stampedePrevention: true,
      gracefulDegradation: { retryAfterMs: 10_000 },
      singleFlightCoordinator: new RedisSingleFlightCoordinator({
        client: redis,
        prefix: 'layercache-bench:http:graceful:single-flight:'
      })
    }
  )

  const origin = createOriginFetcher(fixturePath)

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const userId = Number(url.searchParams.get('id') ?? DEFAULT_USER_ID)

    try {
      if (url.pathname === '/nocache') {
        const user = await origin.run(userId)
        respondJson(response, 200, { route: 'nocache', user })
        return
      }

      if (url.pathname === '/memory') {
        const user = await memoryCache.get(`http:user:${userId}`, () => origin.run(userId))
        respondJson(response, 200, { route: 'memory', user })
        return
      }

      if (url.pathname === '/layered') {
        const user = await layeredCache.get(`http:user:${userId}`, () => origin.run(userId))
        respondJson(response, 200, { route: 'layered', user })
        return
      }

      if (url.pathname === '/layered-graceful') {
        const user = await gracefulLayeredCache.get(`http:user:${userId}`, () => origin.run(userId))
        respondJson(response, 200, { route: 'layered-graceful', user })
        return
      }

      if (url.pathname === '/health') {
        respondJson(response, 200, { ok: true, fetchCount: origin.getCount() })
        return
      }

      respondJson(response, 404, { error: 'not-found' })
    } catch (error) {
      respondJson(response, 500, {
        error: error instanceof Error ? error.message : String(error)
      })
    }
  })

  await listen(server)

  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Unexpected server address state')
  }

  return {
    port: address.port,
    reset: async () => {
      await memoryCache.clear()
      await layeredCache.clear()
      await gracefulLayeredCache.clear()
      await redis.flushdb()
    },
    warm: async () => {
      await memoryCache.get(`http:user:${DEFAULT_USER_ID}`, () => origin.run(DEFAULT_USER_ID))
      await layeredCache.get(`http:user:${DEFAULT_USER_ID}`, () => origin.run(DEFAULT_USER_ID))
      await gracefulLayeredCache.get(`http:user:${DEFAULT_USER_ID}`, () => origin.run(DEFAULT_USER_ID))
    },
    close: async () => {
      await Promise.all([memoryCache.disconnect(), layeredCache.disconnect(), gracefulLayeredCache.disconnect()])
      await closeServer(server)
    }
  }
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error)
        return
      }

      resolve()
    })
  })
}
