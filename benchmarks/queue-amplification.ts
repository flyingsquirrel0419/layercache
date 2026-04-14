import { Redis } from 'ioredis'
import { CacheStack, MemoryLayer, RedisLayer, RedisSingleFlightCoordinator } from '../src'
import { buildConcurrencyLabel, summarizeQueueAmplification } from './queue-amplification-utils'
import { REDIS_PORT, ensureRedisContainer, stopRedisContainer, unpauseRedisContainer, waitForRedisReady } from './redis'
import { startRedisLatencyProxy } from './redis-latency-proxy'
import { type CountedFetcher, createCountedFetcher, runConcurrent } from './scenario-utils'
import { buildDelayLabel } from './slow-redis-utils'

const LATENCY_LEVELS = [0, 100, 500] as const
const CONCURRENCY_LEVELS = [1, 10, 50, 100, 250, 500] as const
const TIMEOUT_MS = 30_000

interface QueueAmplificationResult {
  label: string
  count: number
  minMs: number
  maxMs: number
  avgMs: number
  medianMs: number
  p95Ms: number
  delayLabel: string
  scenario: string
  concurrency: number
  concurrencyLabel: string
  totalWallClockMs: number
  amplificationVsSingle: number
  linearityRatio: number
}

interface BenchmarkCacheContext {
  cache: CacheStack
  memory: MemoryLayer
  originFetcher: CountedFetcher<[], { source: string; warmedAt: number }>
}

function round(value: number): number {
  return Number(value.toFixed(3))
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

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)
    })
  ])
}

function createLayeredCache(redis: Redis, prefix: string, gracefulDegradation: boolean): BenchmarkCacheContext {
  const memory = new MemoryLayer({ ttl: 60, maxSize: 50 })
  const originFetcher = createCountedFetcher(async () => ({
    source: 'origin',
    warmedAt: Date.now()
  }))

  return {
    memory,
    originFetcher,
    cache: new CacheStack([memory, new RedisLayer({ client: redis, ttl: 300, prefix: `${prefix}:cache:` })], {
      stampedePrevention: true,
      ...(gracefulDegradation ? { gracefulDegradation: { retryAfterMs: 10_000 } } : {}),
      singleFlightCoordinator: new RedisSingleFlightCoordinator({
        client: redis,
        prefix: `${prefix}:sf:`
      })
    })
  }
}

async function warmCache(context: BenchmarkCacheContext, key: string): Promise<void> {
  await context.cache.get(key, () => context.originFetcher.run(), { ttl: 60 })
}

async function measureBatch(
  context: BenchmarkCacheContext,
  key: string,
  delayLabel: string,
  scenario: string,
  concurrency: number,
  baselineWallClockMs: number
): Promise<QueueAmplificationResult> {
  await context.memory.clear()

  const originCountBefore = context.originFetcher.getCount()
  const batchStartedAt = process.hrtime.bigint()
  const requestLatenciesMs = await runConcurrent(concurrency, async () => {
    const requestStartedAt = process.hrtime.bigint()
    await withTimeout(
      context.cache.get(key, () => context.originFetcher.run(), { ttl: 60 }),
      TIMEOUT_MS,
      `${delayLabel} ${scenario} ${buildConcurrencyLabel(concurrency)}`
    )

    return Number(process.hrtime.bigint() - requestStartedAt) / 1_000_000
  })
  const totalWallClockMs = Number(process.hrtime.bigint() - batchStartedAt) / 1_000_000

  const originFetchCount = context.originFetcher.getCount() - originCountBefore
  if (originFetchCount !== 0) {
    throw new Error(
      `${delayLabel} ${scenario} ${buildConcurrencyLabel(concurrency)} unexpectedly fetched origin ${originFetchCount} times`
    )
  }

  return summarizeQueueAmplification({
    delayLabel,
    scenario,
    concurrency,
    totalWallClockMs,
    requestLatenciesMs,
    baselineWallClockMs
  })
}

async function runDelayBenchmarks(delayMs: number): Promise<QueueAmplificationResult[]> {
  const delayLabel = buildDelayLabel(delayMs)
  const proxy = await startRedisLatencyProxy(REDIS_PORT)
  proxy.setLatencyMs(delayMs)

  const strictRedis = createBenchmarkRedis(proxy.port)
  const gracefulRedis = createBenchmarkRedis(proxy.port)

  await Promise.all([strictRedis.connect(), gracefulRedis.connect()])
  await Promise.all([strictRedis.ping(), gracefulRedis.ping()])

  const strict = createLayeredCache(strictRedis, `queue:${delayMs}:strict:${Date.now()}`, false)
  const graceful = createLayeredCache(gracefulRedis, `queue:${delayMs}:graceful:${Date.now()}`, true)

  try {
    const strictKey = `queue:strict:${delayMs}`
    const gracefulKey = `queue:graceful:${delayMs}`

    await warmCache(strict, strictKey)
    await warmCache(graceful, gracefulKey)

    const scenarios = [
      { scenario: 'strict-l2-hit', context: strict, key: strictKey },
      { scenario: 'graceful-l2-hit', context: graceful, key: gracefulKey }
    ]

    const results: QueueAmplificationResult[] = []

    for (const { scenario, context, key } of scenarios) {
      let baselineWallClockMs = 0

      for (const concurrency of CONCURRENCY_LEVELS) {
        const effectiveBaseline = baselineWallClockMs || 1
        const summary = await measureBatch(
          context,
          key,
          delayLabel,
          scenario,
          concurrency,
          concurrency === 1 ? effectiveBaseline : baselineWallClockMs
        )

        if (concurrency === 1) {
          baselineWallClockMs = summary.totalWallClockMs
          results.push({
            ...summary,
            amplificationVsSingle: 1,
            linearityRatio: 1
          })
          continue
        }

        results.push(summary)
      }
    }

    return results
  } finally {
    await strict.cache.disconnect().catch(() => {})
    await graceful.cache.disconnect().catch(() => {})
    await strictRedis.quit().catch(() => {})
    await gracefulRedis.quit().catch(() => {})
    await proxy.close().catch(() => {})
  }
}

async function main(): Promise<void> {
  await ensureRedisContainer()
  await waitForRedisReady()

  try {
    const results: QueueAmplificationResult[] = []
    for (const delayMs of LATENCY_LEVELS) {
      results.push(...(await runDelayBenchmarks(delayMs)))
    }

    console.table(
      results.map((result) => ({
        delay: result.delayLabel,
        scenario: result.scenario,
        concurrency: result.concurrency,
        totalWallClockMs: round(result.totalWallClockMs),
        avgMs: result.avgMs,
        p95Ms: result.p95Ms,
        maxMs: result.maxMs,
        amplificationVsSingle: result.amplificationVsSingle,
        linearityRatio: result.linearityRatio
      }))
    )
    console.log(JSON.stringify({ type: 'queue-amplification-benchmark', results }, null, 2))
  } finally {
    await unpauseRedisContainer().catch(() => {})
    await stopRedisContainer()
  }
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
