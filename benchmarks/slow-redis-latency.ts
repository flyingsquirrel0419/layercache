import { Redis } from 'ioredis'
import { CacheStack, MemoryLayer, RedisLayer, RedisSingleFlightCoordinator } from '../src'
import {
  REDIS_PORT,
  ensureRedisContainer,
  pauseRedisContainer,
  stopRedisContainer,
  unpauseRedisContainer,
  waitForRedisReady
} from './redis'
import { startRedisLatencyProxy } from './redis-latency-proxy'
import { buildDelayLabel } from './slow-redis-utils'

const LATENCY_LEVELS = [0, 100, 500] as const
const TIMEOUT_MS = 6_000
const COMMAND_TIMEOUT_MS = 200

interface SlowRedisResult {
  delayLabel: string
  scenario: string
  success: boolean
  latencyMs: number
  error: string | null
}

interface LayeredCacheContext {
  cache: CacheStack
  memory: MemoryLayer
}

function round(value: number): number {
  return Number(value.toFixed(3))
}

function normalizeResult(
  delayLabel: string,
  scenario: string,
  success: boolean,
  latencyMs: number,
  error?: string
): SlowRedisResult {
  return {
    delayLabel,
    scenario,
    success,
    latencyMs: round(latencyMs),
    error: error ?? null
  }
}

function createBenchmarkRedis(port: number): Redis {
  const client = new Redis({
    host: '127.0.0.1',
    port,
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    connectTimeout: 6_000,
    enableOfflineQueue: false,
    autoResendUnfulfilledCommands: false,
    retryStrategy: () => null
  })

  client.on('error', () => {})
  return client
}

async function measure<TResult>(task: () => Promise<TResult>): Promise<{ durationMs: number; result: TResult }> {
  const startedAt = process.hrtime.bigint()
  const result = await task()

  return {
    durationMs: Number(process.hrtime.bigint() - startedAt) / 1_000_000,
    result
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)
    })
  ])
}

function createLayeredCache(redis: Redis, prefix: string, gracefulDegradation: boolean): LayeredCacheContext {
  const memory = new MemoryLayer({ ttl: 60, maxSize: 50 })
  const cache = new CacheStack(
    [
      memory,
      new RedisLayer({
        client: redis,
        ttl: 300,
        prefix: `${prefix}:cache:`,
        commandTimeoutMs: COMMAND_TIMEOUT_MS
      })
    ],
    {
      stampedePrevention: true,
      ...(gracefulDegradation ? { gracefulDegradation: { retryAfterMs: 10_000 } } : {}),
      singleFlightCoordinator: new RedisSingleFlightCoordinator({
        client: redis,
        prefix: `${prefix}:sf:`,
        commandTimeoutMs: COMMAND_TIMEOUT_MS
      })
    }
  )

  return {
    cache,
    memory
  }
}

async function runSlowRedisAtDelay(delayMs: number): Promise<SlowRedisResult[]> {
  const delayLabel = buildDelayLabel(delayMs)
  const proxy = await startRedisLatencyProxy(REDIS_PORT)

  const strictRedis = createBenchmarkRedis(proxy.port)
  const gracefulRedis = createBenchmarkRedis(proxy.port)

  await Promise.all([strictRedis.connect(), gracefulRedis.connect()])
  await Promise.all([strictRedis.ping(), gracefulRedis.ping()])

  const strict = createLayeredCache(strictRedis, `slow:strict:${delayMs}:${Date.now()}`, false)
  const graceful = createLayeredCache(gracefulRedis, `slow:graceful:${delayMs}:${Date.now()}`, true)

  try {
    await strict.cache.get('warm:key', async () => ({ source: 'origin', delayMs }), { ttl: 60 })
    await graceful.cache.get('warm:key', async () => ({ source: 'origin', delayMs }), { ttl: 60 })
    proxy.setLatencyMs(delayMs)

    const hotStrict = await measure(() =>
      withTimeout(strict.cache.get('warm:key'), TIMEOUT_MS, `${delayLabel} strict hot`)
    )
      .then(({ durationMs }) => normalizeResult(delayLabel, 'strict-hot-hit', true, durationMs))
      .catch((error) =>
        normalizeResult(delayLabel, 'strict-hot-hit', false, 0, error instanceof Error ? error.message : String(error))
      )

    const hotGraceful = await measure(() =>
      withTimeout(graceful.cache.get('warm:key'), TIMEOUT_MS, `${delayLabel} graceful hot`)
    )
      .then(({ durationMs }) => normalizeResult(delayLabel, 'graceful-hot-hit', true, durationMs))
      .catch((error) =>
        normalizeResult(
          delayLabel,
          'graceful-hot-hit',
          false,
          0,
          error instanceof Error ? error.message : String(error)
        )
      )

    await Promise.all([strict.memory.clear().catch(() => undefined), graceful.memory.clear().catch(() => undefined)])

    const l2Strict = await measure(() =>
      withTimeout(strict.cache.get('warm:key'), TIMEOUT_MS, `${delayLabel} strict l2`)
    )
      .then(({ durationMs }) => normalizeResult(delayLabel, 'strict-l2-hit', true, durationMs))
      .catch((error) =>
        normalizeResult(delayLabel, 'strict-l2-hit', false, 0, error instanceof Error ? error.message : String(error))
      )

    const l2Graceful = await measure(() =>
      withTimeout(graceful.cache.get('warm:key'), TIMEOUT_MS, `${delayLabel} graceful l2`)
    )
      .then(({ durationMs }) => normalizeResult(delayLabel, 'graceful-l2-hit', true, durationMs))
      .catch((error) =>
        normalizeResult(delayLabel, 'graceful-l2-hit', false, 0, error instanceof Error ? error.message : String(error))
      )

    const coldStrict = await measure(() =>
      withTimeout(
        strict.cache.get('cold:key', async () => ({ source: 'origin', delayMs }), { ttl: 60 }),
        TIMEOUT_MS,
        `${delayLabel} strict cold`
      )
    )
      .then(({ durationMs }) => normalizeResult(delayLabel, 'strict-cold-miss', true, durationMs))
      .catch((error) =>
        normalizeResult(
          delayLabel,
          'strict-cold-miss',
          false,
          0,
          error instanceof Error ? error.message : String(error)
        )
      )

    const coldGraceful = await measure(() =>
      withTimeout(
        graceful.cache.get('cold:key', async () => ({ source: 'origin', delayMs }), { ttl: 60 }),
        TIMEOUT_MS,
        `${delayLabel} graceful cold`
      )
    )
      .then(({ durationMs }) => normalizeResult(delayLabel, 'graceful-cold-miss', true, durationMs))
      .catch((error) =>
        normalizeResult(
          delayLabel,
          'graceful-cold-miss',
          false,
          0,
          error instanceof Error ? error.message : String(error)
        )
      )

    return [hotStrict, hotGraceful, l2Strict, l2Graceful, coldStrict, coldGraceful]
  } finally {
    await strict.cache.disconnect().catch(() => {})
    await graceful.cache.disconnect().catch(() => {})
    await strictRedis.quit().catch(() => {})
    await gracefulRedis.quit().catch(() => {})
    await proxy.close().catch(() => {})
  }
}

async function runDeadRedisContrast(): Promise<SlowRedisResult[]> {
  const strictRedis = createBenchmarkRedis(REDIS_PORT)
  const gracefulRedis = createBenchmarkRedis(REDIS_PORT)

  await Promise.all([strictRedis.connect(), gracefulRedis.connect()])
  await Promise.all([strictRedis.ping(), gracefulRedis.ping()])

  const strict = createLayeredCache(strictRedis, `dead:strict:${Date.now()}`, false)
  const graceful = createLayeredCache(gracefulRedis, `dead:graceful:${Date.now()}`, true)

  try {
    await strict.cache.get('warm:key', async () => ({ source: 'origin' }), { ttl: 60 })
    await graceful.cache.get('warm:key', async () => ({ source: 'origin' }), { ttl: 60 })

    await pauseRedisContainer()

    const strictCold = await measure(() =>
      withTimeout(
        strict.cache.get('cold:key', async () => ({ source: 'origin' }), { ttl: 60 }),
        2_000,
        'dead strict cold'
      )
    )
      .then(({ durationMs }) => normalizeResult('dead', 'dead-strict-cold-miss', true, durationMs))
      .catch((error) =>
        normalizeResult(
          'dead',
          'dead-strict-cold-miss',
          false,
          0,
          error instanceof Error ? error.message : String(error)
        )
      )

    const gracefulCold = await measure(() =>
      withTimeout(
        graceful.cache.get('cold:key', async () => ({ source: 'origin' }), { ttl: 60 }),
        2_000,
        'dead graceful cold'
      )
    )
      .then(({ durationMs }) => normalizeResult('dead', 'dead-graceful-cold-miss', true, durationMs))
      .catch((error) =>
        normalizeResult(
          'dead',
          'dead-graceful-cold-miss',
          false,
          0,
          error instanceof Error ? error.message : String(error)
        )
      )

    return [strictCold, gracefulCold]
  } finally {
    await unpauseRedisContainer().catch(() => {})
    await waitForRedisReady()
    await strict.cache.disconnect().catch(() => {})
    await graceful.cache.disconnect().catch(() => {})
    await strictRedis.quit().catch(() => {})
    await gracefulRedis.quit().catch(() => {})
  }
}

async function main(): Promise<void> {
  await ensureRedisContainer()
  await waitForRedisReady()

  try {
    const slowRedisResults: SlowRedisResult[] = []
    for (const delayMs of LATENCY_LEVELS) {
      slowRedisResults.push(...(await runSlowRedisAtDelay(delayMs)))
    }

    await stopRedisContainer()
    await ensureRedisContainer()
    await waitForRedisReady()

    const deadRedisResults = await runDeadRedisContrast()

    console.table(slowRedisResults.concat(deadRedisResults))
    console.log(JSON.stringify({ type: 'slow-redis-latency', slowRedisResults, deadRedisResults }, null, 2))
  } finally {
    await unpauseRedisContainer().catch(() => {})
    await stopRedisContainer()
  }
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
