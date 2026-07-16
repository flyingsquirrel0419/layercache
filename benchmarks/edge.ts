import { CacheStack, MemoryLayer, RedisInvalidationBus, RedisLayer, RedisSingleFlightCoordinator } from '../src'
import { type OutageResult, buildPayloadString, normalizeOutageResult } from './edge-utils'
import {
  createRedisClient,
  ensureRedisContainer,
  pauseRedisContainer,
  stopRedisContainer,
  unpauseRedisContainer,
  waitForRedisReady
} from './redis'
import { createCountedFetcher, runConcurrent, summarizeScenario } from './scenario-utils'
import { type DurationSummary, summarizeDurations } from './stats'

const TTL_CONCURRENCY = 40
const TTL_RUNS = 5
const TTL_MS = 1_100
const PAYLOAD_SAMPLES = 60
const PAYLOAD_SMALL_BYTES = 1_024
const PAYLOAD_LARGE_BYTES = 1_024 * 1_024
const DISTRIBUTED_CONCURRENCY = 60
const COMMAND_TIMEOUT_MS = 200

interface ModeSummary extends DurationSummary {
  mode: string
  scenario: string
  fetchCount?: number
}

interface InvalidationResult {
  scenario: string
  success: boolean
  latencyMs: number
  observedVersion: number | null
}

interface DistributedSingleFlightResult {
  scenario: string
  concurrency: number
  latencyMs: number
  fetchCount: number
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function measure<TResult>(task: () => Promise<TResult>): Promise<{ durationMs: number; result: TResult }> {
  const startedAt = process.hrtime.bigint()
  const result = await task()
  return {
    durationMs: Number(process.hrtime.bigint() - startedAt) / 1_000_000,
    result
  }
}

function requireValue<T>(value: T | undefined, label: string): T {
  if (value === undefined) {
    throw new Error(`${label} unexpectedly returned undefined`)
  }

  return value
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)
    })
  ])
}

async function runTtlExpiryStampede(): Promise<ModeSummary[]> {
  const redis = createRedisClient()
  await redis.ping()

  const memoryCache = new CacheStack([new MemoryLayer({ ttl: 1_000, maxSize: 1_000 })], {
    stampedePrevention: true
  })

  const layeredCache = new CacheStack(
    [
      new MemoryLayer({ ttl: 1_000, maxSize: 1_000 }),
      new RedisLayer({ client: redis, ttl: 1_000, prefix: 'layercache-bench:edge:ttl:' })
    ],
    {
      stampedePrevention: true,
      singleFlightCoordinator: new RedisSingleFlightCoordinator({
        client: redis,
        prefix: 'layercache-bench:edge:ttl:sf:'
      })
    }
  )

  try {
    const results: ModeSummary[] = []

    for (const { mode, cache } of [
      { mode: 'memory', cache: memoryCache },
      { mode: 'layered', cache: layeredCache }
    ]) {
      const samples: number[] = []
      let fetchCount = 0

      for (let index = 0; index < TTL_RUNS; index += 1) {
        await cache.clear()
        if (mode === 'layered') {
          await redis.flushdb()
        }

        await cache.get(`ttl:key:${index}`, async () => ({ version: 1 }), { ttl: 1_000 })
        await sleep(TTL_MS)

        const fetcher = createCountedFetcher(async () => ({ version: 2 }))
        const { durationMs } = await measure(() =>
          runConcurrent(TTL_CONCURRENCY, async () =>
            requireValue(await cache.get(`ttl:key:${index}`, () => fetcher.run(), { ttl: 1_000 }), `${mode} ttl`)
          )
        )

        samples.push(durationMs)
        fetchCount += fetcher.getCount()
      }

      results.push({
        ...summarizeScenario('ttl-expiry-stampede', samples, fetchCount),
        mode,
        scenario: 'ttl-expiry-stampede'
      })
    }

    return results
  } finally {
    await Promise.all([memoryCache.disconnect(), layeredCache.disconnect()])
    await redis.quit()
  }
}

async function runPayloadSizeVariation(): Promise<ModeSummary[]> {
  const redis = createRedisClient()
  await redis.ping()

  const memoryCache = new CacheStack([new MemoryLayer({ ttl: 60_000, maxSize: 100 })])
  const redisCache = new CacheStack([
    new RedisLayer({ client: redis, ttl: 300_000, prefix: 'layercache-bench:edge:payload:' })
  ])

  try {
    const results: ModeSummary[] = []

    for (const scenario of [
      { mode: 'memory-1kb', cache: memoryCache, bytes: PAYLOAD_SMALL_BYTES },
      { mode: 'memory-1mb', cache: memoryCache, bytes: PAYLOAD_LARGE_BYTES },
      { mode: 'redis-1kb', cache: redisCache, bytes: PAYLOAD_SMALL_BYTES },
      { mode: 'redis-1mb', cache: redisCache, bytes: PAYLOAD_LARGE_BYTES }
    ]) {
      await scenario.cache.clear()
      if (scenario.mode.startsWith('redis')) {
        await redis.flushdb()
      }

      await scenario.cache.set(
        `payload:${scenario.mode}`,
        { size: scenario.bytes, payload: buildPayloadString(scenario.bytes) },
        { ttl: 60_000 }
      )

      const samples: number[] = []
      for (let index = 0; index < PAYLOAD_SAMPLES; index += 1) {
        const { durationMs } = await measure(async () => {
          requireValue(await scenario.cache.get(`payload:${scenario.mode}`), `${scenario.mode} payload`)
        })
        samples.push(durationMs)
      }

      results.push({
        ...summarizeDurations('payload-warm-hit', samples),
        mode: scenario.mode,
        scenario: 'payload-warm-hit'
      })
    }

    return results
  } finally {
    await Promise.all([memoryCache.disconnect(), redisCache.disconnect()])
    await redis.quit()
  }
}

async function runRedisOutageScenario(): Promise<OutageResult[]> {
  const strictRedis = createRedisClient()
  const gracefulRedis = createRedisClient()
  await Promise.all([strictRedis.ping(), gracefulRedis.ping()])

  const strictCache = new CacheStack(
    [
      new MemoryLayer({ ttl: 60_000, maxSize: 500 }),
      new RedisLayer({
        client: strictRedis,
        ttl: 300_000,
        prefix: 'layercache-bench:edge:strict:',
        commandTimeoutMs: COMMAND_TIMEOUT_MS
      })
    ],
    {
      stampedePrevention: true,
      singleFlightCoordinator: new RedisSingleFlightCoordinator({
        client: strictRedis,
        prefix: 'layercache-bench:edge:strict:sf:',
        commandTimeoutMs: COMMAND_TIMEOUT_MS
      })
    }
  )

  const gracefulCache = new CacheStack(
    [
      new MemoryLayer({ ttl: 60_000, maxSize: 500 }),
      new RedisLayer({
        client: gracefulRedis,
        ttl: 300_000,
        prefix: 'layercache-bench:edge:graceful:',
        commandTimeoutMs: COMMAND_TIMEOUT_MS
      })
    ],
    {
      stampedePrevention: true,
      gracefulDegradation: { retryAfterMs: 10_000 },
      singleFlightCoordinator: new RedisSingleFlightCoordinator({
        client: gracefulRedis,
        prefix: 'layercache-bench:edge:graceful:sf:',
        commandTimeoutMs: COMMAND_TIMEOUT_MS
      })
    }
  )

  try {
    await strictCache.clear()
    await gracefulCache.clear()
    await strictRedis.flushdb()

    await strictCache.get('outage:warm', async () => ({ version: 'warm-strict' }), { ttl: 60_000 })
    await gracefulCache.get('outage:warm', async () => ({ version: 'warm-graceful' }), { ttl: 60_000 })

    await pauseRedisContainer()

    const hotResults = await Promise.all([
      measure(async () => {
        requireValue(await strictCache.get('outage:warm'), 'strict hot')
      })
        .then(({ durationMs }) => normalizeOutageResult('strict-hot-hit', true, durationMs))
        .catch((error) =>
          normalizeOutageResult('strict-hot-hit', false, 0, error instanceof Error ? error.message : String(error))
        ),
      measure(async () => {
        requireValue(await gracefulCache.get('outage:warm'), 'graceful hot')
      })
        .then(({ durationMs }) => normalizeOutageResult('graceful-hot-hit', true, durationMs))
        .catch((error) =>
          normalizeOutageResult('graceful-hot-hit', false, 0, error instanceof Error ? error.message : String(error))
        )
    ])

    const coldStrict = await measure(() =>
      withTimeout(
        strictCache.get('outage:cold:strict', async () => ({ version: 'strict-cold' }), { ttl: 60_000 }),
        2_000,
        'strict cold miss'
      )
    )
      .then(({ durationMs }) => normalizeOutageResult('strict-cold-miss', true, durationMs))
      .catch((error) =>
        normalizeOutageResult('strict-cold-miss', false, 0, error instanceof Error ? error.message : String(error))
      )

    const coldGraceful = await measure(() =>
      withTimeout(
        gracefulCache.get('outage:cold:graceful', async () => ({ version: 'graceful-cold' }), { ttl: 60_000 }),
        2_000,
        'graceful cold miss'
      )
    )
      .then(({ durationMs }) => normalizeOutageResult('graceful-cold-miss', true, durationMs))
      .catch((error) =>
        normalizeOutageResult('graceful-cold-miss', false, 0, error instanceof Error ? error.message : String(error))
      )

    return [...hotResults, coldStrict, coldGraceful]
  } finally {
    await unpauseRedisContainer()
    await waitForRedisReady()
    await Promise.all([strictCache.disconnect(), gracefulCache.disconnect()])
    await Promise.all([strictRedis.quit(), gracefulRedis.quit()])
  }
}

async function runMultiInstanceInvalidation(): Promise<InvalidationResult> {
  const publisher = createRedisClient()
  const subscriberA = createRedisClient()
  const subscriberB = createRedisClient()
  const dataA = createRedisClient()
  const dataB = createRedisClient()

  await Promise.all([publisher.ping(), subscriberA.ping(), subscriberB.ping(), dataA.ping(), dataB.ping()])

  const busA = new RedisInvalidationBus({
    publisher,
    subscriber: subscriberA,
    channel: 'layercache-bench:edge:invalidation'
  })
  const busB = new RedisInvalidationBus({
    publisher,
    subscriber: subscriberB,
    channel: 'layercache-bench:edge:invalidation'
  })

  const cacheA = new CacheStack(
    [
      new MemoryLayer({ ttl: 60_000, maxSize: 100 }),
      new RedisLayer({ client: dataA, ttl: 300_000, prefix: 'layercache-bench:edge:invalidation:' })
    ],
    {
      invalidationBus: busA,
      broadcastL1Invalidation: true
    }
  )
  const cacheB = new CacheStack(
    [
      new MemoryLayer({ ttl: 60_000, maxSize: 100 }),
      new RedisLayer({ client: dataB, ttl: 300_000, prefix: 'layercache-bench:edge:invalidation:' })
    ],
    {
      invalidationBus: busB,
      broadcastL1Invalidation: true
    }
  )

  try {
    await cacheA.clear()
    await dataA.flushdb()

    await cacheA.get('shared:key', async () => ({ version: 1 }), { ttl: 60_000 })
    await cacheB.get('shared:key', async () => ({ version: 1 }), { ttl: 60_000 })

    await cacheA.delete('shared:key')
    await cacheA.get('shared:key', async () => ({ version: 2 }), { ttl: 60_000 })

    const startedAt = performance.now()
    let observedVersion: number | null = null
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const value = await cacheB.get<{ version: number }>('shared:key')
      observedVersion = value?.version ?? null
      if (observedVersion === 2) {
        return {
          scenario: 'multi-instance-invalidation',
          success: true,
          latencyMs: Number((performance.now() - startedAt).toFixed(3)),
          observedVersion
        }
      }

      await sleep(25)
    }

    return {
      scenario: 'multi-instance-invalidation',
      success: false,
      latencyMs: Number((performance.now() - startedAt).toFixed(3)),
      observedVersion
    }
  } finally {
    await Promise.all([cacheA.disconnect(), cacheB.disconnect()])
    await Promise.all([publisher.quit(), subscriberA.quit(), subscriberB.quit(), dataA.quit(), dataB.quit()])
  }
}

async function runDistributedSingleFlight(): Promise<DistributedSingleFlightResult> {
  const redisA = createRedisClient()
  const redisB = createRedisClient()
  const coordinatorClient = createRedisClient()

  await Promise.all([redisA.ping(), redisB.ping(), coordinatorClient.ping()])

  const coordinator = new RedisSingleFlightCoordinator({
    client: coordinatorClient,
    prefix: 'layercache-bench:edge:distributed:sf:'
  })

  const cacheA = new CacheStack(
    [
      new MemoryLayer({ ttl: 60_000, maxSize: 100 }),
      new RedisLayer({ client: redisA, ttl: 300_000, prefix: 'layercache-bench:edge:distributed:' })
    ],
    {
      stampedePrevention: true,
      singleFlightCoordinator: coordinator
    }
  )
  const cacheB = new CacheStack(
    [
      new MemoryLayer({ ttl: 60_000, maxSize: 100 }),
      new RedisLayer({ client: redisB, ttl: 300_000, prefix: 'layercache-bench:edge:distributed:' })
    ],
    {
      stampedePrevention: true,
      singleFlightCoordinator: coordinator
    }
  )

  try {
    await cacheA.clear()
    await redisA.flushdb()

    let fetchCount = 0
    const fetchUser = async () => {
      fetchCount += 1
      await sleep(25)
      return { id: 1 }
    }

    const startedAt = performance.now()
    await runConcurrent(DISTRIBUTED_CONCURRENCY, (index) =>
      (index % 2 === 0 ? cacheA : cacheB)
        .get('distributed:user:1', fetchUser)
        .then((value) => requireValue(value, 'distributed'))
    )

    return {
      scenario: 'distributed-single-flight',
      concurrency: DISTRIBUTED_CONCURRENCY,
      latencyMs: Number((performance.now() - startedAt).toFixed(3)),
      fetchCount
    }
  } finally {
    await Promise.all([cacheA.disconnect(), cacheB.disconnect()])
    await Promise.all([redisA.quit(), redisB.quit(), coordinatorClient.quit()])
  }
}

async function main(): Promise<void> {
  await ensureRedisContainer()
  await waitForRedisReady()

  try {
    const ttlResults = await runTtlExpiryStampede()
    const payloadResults = await runPayloadSizeVariation()
    const outageResults = await runRedisOutageScenario()
    const invalidationResult = await runMultiInstanceInvalidation()
    const distributedResult = await runDistributedSingleFlight()

    console.table([
      ...ttlResults.map((result) => ({
        mode: result.mode,
        scenario: result.scenario,
        avgMs: result.avgMs,
        p95Ms: result.p95Ms,
        fetchCount: result.fetchCount
      })),
      ...payloadResults.map((result) => ({
        mode: result.mode,
        scenario: result.scenario,
        avgMs: result.avgMs,
        p95Ms: result.p95Ms
      })),
      ...outageResults,
      invalidationResult,
      distributedResult
    ])
    console.log(
      JSON.stringify(
        {
          type: 'edge-benchmark',
          ttlResults,
          payloadResults,
          outageResults,
          invalidationResult,
          distributedResult
        },
        null,
        2
      )
    )
  } finally {
    await unpauseRedisContainer().catch(() => {})
    await stopRedisContainer()
  }
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
