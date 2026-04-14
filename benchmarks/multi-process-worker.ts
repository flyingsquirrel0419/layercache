import { CacheStack, MemoryLayer, RedisInvalidationBus, RedisLayer, RedisSingleFlightCoordinator } from '../src'
import { createRedisClient } from './redis'
import { runConcurrent } from './scenario-utils'

interface InitMessage {
  id: string
  type: 'init'
  prefix: string
  busChannel?: string
  commandTimeoutMs?: number
}

interface SeedMessage {
  id: string
  type: 'seed'
  key: string
  value: unknown
}

interface ReadMessage {
  id: string
  type: 'read'
  key: string
}

interface BurstMessage {
  id: string
  type: 'burst'
  key: string
  startAt: number
  concurrency: number
  originCounterKey: string
  fetchDelayMs: number
}

interface DisposeMessage {
  id: string
  type: 'dispose'
}

type WorkerMessage = InitMessage | SeedMessage | ReadMessage | BurstMessage | DisposeMessage

let cache: CacheStack | undefined
const redis = createRedisClient()

function reply(id: string, ok: boolean, result?: unknown, error?: unknown): void {
  process.send?.({
    id,
    ok,
    result,
    error: error instanceof Error ? error.message : error
  })
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

async function ensureInitialized(message: WorkerMessage): Promise<CacheStack> {
  if (!cache) {
    throw new Error(`Worker received "${message.type}" before init.`)
  }

  return cache
}

process.on('message', async (message: WorkerMessage) => {
  try {
    if (message.type === 'init') {
      if (cache) {
        throw new Error('Worker already initialized.')
      }

      const layer = new RedisLayer({
        client: redis,
        ttl: 300,
        prefix: `${message.prefix}:cache:`,
        commandTimeoutMs: message.commandTimeoutMs
      })
      const bus =
        message.busChannel === undefined
          ? undefined
          : new RedisInvalidationBus({
              publisher: redis,
              subscriber: redis.duplicate(),
              channel: message.busChannel
            })

      cache = new CacheStack([new MemoryLayer({ ttl: 60, maxSize: 1_000 }), layer], {
        stampedePrevention: true,
        invalidationBus: bus,
        broadcastL1Invalidation: bus ? true : undefined,
        singleFlightCoordinator: new RedisSingleFlightCoordinator({
          client: redis,
          prefix: `${message.prefix}:sf:`,
          commandTimeoutMs: message.commandTimeoutMs
        })
      })
      reply(message.id, true, { initialized: true })
      return
    }

    if (message.type === 'dispose') {
      await cache?.disconnect()
      await redis.quit()
      reply(message.id, true, { disposed: true })
      process.exit(0)
      return
    }

    const initializedCache = await ensureInitialized(message)

    if (message.type === 'seed') {
      await initializedCache.set(message.key, message.value, { ttl: 60 })
      reply(message.id, true, { seeded: true })
      return
    }

    if (message.type === 'read') {
      const value = await initializedCache.get(message.key)
      reply(message.id, true, value)
      return
    }

    if (message.type === 'burst') {
      const waitMs = Math.max(0, message.startAt - Date.now())
      if (waitMs > 0) {
        await sleep(waitMs)
      }

      const startedAt = process.hrtime.bigint()
      await runConcurrent(message.concurrency, async () => {
        await initializedCache.get(
          message.key,
          async () => {
            await redis.incr(message.originCounterKey)
            await sleep(message.fetchDelayMs)
            return { key: message.key, fetchedAt: Date.now() }
          },
          { ttl: 60 }
        )
      })
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000
      reply(message.id, true, { durationMs })
    }
  } catch (error) {
    reply(message.id, false, undefined, error)
  }
})
