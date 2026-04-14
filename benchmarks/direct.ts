import { performance } from 'node:perf_hooks'
import type { Redis } from 'ioredis'
import { CacheStack, MemoryLayer, RedisLayer, RedisSingleFlightCoordinator } from '../src'
import { resolveBenchmarkFixturePath } from './paths'
import { createRedisClient, ensureRedisContainer, stopRedisContainer, waitForRedisReady } from './redis'
import { type ScenarioSummary, createCountedFetcher, runConcurrent, summarizeScenario } from './scenario-utils'
import { ensureFixtureFile, loadUserFromFixture } from './workload'

const USER_ID = 4242
const COLD_SAMPLES = 15
const WARM_SAMPLES = 120
const STAMPEDE_CONCURRENCY = 75
const STAMPEDE_RUNS = 5

type BenchmarkMode = 'no-cache' | 'memory' | 'layered'

interface FlattenedResult extends ScenarioSummary {
  mode: BenchmarkMode
  scenario: string
}

type CacheRunner = {
  read: <T>(key: string, fetcher: () => Promise<T>) => Promise<T>
  clear: () => Promise<void>
  disconnect?: () => Promise<void>
}

function createOriginFetcher(fixturePath: string) {
  return createCountedFetcher(async (userId: number) => loadUserFromFixture(fixturePath, userId))
}

function createNoCacheRunner(): CacheRunner {
  return {
    read: async <T>(_key: string, fetcher: () => Promise<T>) => fetcher(),
    clear: async () => {}
  }
}

function createMemoryRunner(): CacheRunner {
  const cache = new CacheStack([new MemoryLayer({ ttl: 60, maxSize: 2_000 })], {
    stampedePrevention: true
  })

  return {
    read: async <T>(key: string, fetcher: () => Promise<T>) => {
      const value = await cache.get(key, fetcher)
      if (value === null) {
        throw new Error(`Cache unexpectedly returned null for ${key}`)
      }

      return value
    },
    clear: async () => {
      await cache.clear()
    },
    disconnect: async () => {
      await cache.disconnect()
    }
  }
}

function createLayeredRunner(redis: Redis): CacheRunner {
  const cache = new CacheStack(
    [
      new MemoryLayer({ ttl: 60, maxSize: 2_000 }),
      new RedisLayer({ client: redis, ttl: 300, prefix: 'layercache-bench:direct:' })
    ],
    {
      stampedePrevention: true,
      singleFlightCoordinator: new RedisSingleFlightCoordinator({
        client: redis,
        prefix: 'layercache-bench:direct:single-flight:'
      })
    }
  )

  return {
    read: async <T>(key: string, fetcher: () => Promise<T>) => {
      const value = await cache.get(key, fetcher)
      if (value === null) {
        throw new Error(`Cache unexpectedly returned null for ${key}`)
      }

      return value
    },
    clear: async () => {
      await cache.clear()
      await redis.flushdb()
    },
    disconnect: async () => {
      await cache.disconnect()
    }
  }
}

async function measure<TResult>(task: () => Promise<TResult>): Promise<{ durationMs: number; result: TResult }> {
  const startedAt = process.hrtime.bigint()
  const result = await task()
  const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000

  return { durationMs, result }
}

async function runColdMiss(mode: BenchmarkMode, runner: CacheRunner, fixturePath: string): Promise<FlattenedResult> {
  const samples: number[] = []
  let fetchCount = 0

  for (let index = 0; index < COLD_SAMPLES; index += 1) {
    await runner.clear()
    const origin = createOriginFetcher(fixturePath)
    const { durationMs } = await measure(() => runner.read(`user:${USER_ID}`, () => origin.run(USER_ID)))
    samples.push(durationMs)
    fetchCount += origin.getCount()
  }

  return {
    ...summarizeScenario('cold-miss', samples, fetchCount),
    mode,
    scenario: 'cold-miss'
  }
}

async function runWarmHit(mode: BenchmarkMode, runner: CacheRunner, fixturePath: string): Promise<FlattenedResult> {
  const samples: number[] = []
  const warmOrigin = createOriginFetcher(fixturePath)

  await runner.clear()
  await runner.read(`user:${USER_ID}`, () => warmOrigin.run(USER_ID))

  const measuredOrigin = createOriginFetcher(fixturePath)
  for (let index = 0; index < WARM_SAMPLES; index += 1) {
    const { durationMs } = await measure(() => runner.read(`user:${USER_ID}`, () => measuredOrigin.run(USER_ID)))
    samples.push(durationMs)
  }

  return {
    ...summarizeScenario('warm-hit', samples, measuredOrigin.getCount()),
    mode,
    scenario: 'warm-hit'
  }
}

async function runStampede(mode: BenchmarkMode, runner: CacheRunner, fixturePath: string): Promise<FlattenedResult> {
  const samples: number[] = []
  let fetchCount = 0

  for (let index = 0; index < STAMPEDE_RUNS; index += 1) {
    await runner.clear()
    const origin = createOriginFetcher(fixturePath)
    const { durationMs } = await measure(() =>
      runConcurrent(STAMPEDE_CONCURRENCY, () => runner.read(`user:${USER_ID}`, () => origin.run(USER_ID)))
    )

    samples.push(durationMs)
    fetchCount += origin.getCount()
  }

  return {
    ...summarizeScenario('stampede', samples, fetchCount),
    mode,
    scenario: 'stampede'
  }
}

async function main(): Promise<void> {
  const fixturePath = resolveBenchmarkFixturePath()
  await ensureFixtureFile(fixturePath)
  await ensureRedisContainer()

  await waitForRedisReady()
  const redis = createRedisClient()
  await redis.ping()

  const runners: Record<BenchmarkMode, CacheRunner> = {
    'no-cache': createNoCacheRunner(),
    memory: createMemoryRunner(),
    layered: createLayeredRunner(redis)
  }

  try {
    const results = [
      await runColdMiss('no-cache', runners['no-cache'], fixturePath),
      await runColdMiss('memory', runners.memory, fixturePath),
      await runColdMiss('layered', runners.layered, fixturePath),
      await runWarmHit('no-cache', runners['no-cache'], fixturePath),
      await runWarmHit('memory', runners.memory, fixturePath),
      await runWarmHit('layered', runners.layered, fixturePath),
      await runStampede('no-cache', runners['no-cache'], fixturePath),
      await runStampede('memory', runners.memory, fixturePath),
      await runStampede('layered', runners.layered, fixturePath)
    ]

    console.table(
      results.map((result) => ({
        mode: result.mode,
        scenario: result.scenario,
        avgMs: result.avgMs,
        p95Ms: result.p95Ms,
        minMs: result.minMs,
        maxMs: result.maxMs,
        fetchCount: result.fetchCount
      }))
    )

    console.log(JSON.stringify({ type: 'direct-benchmark', results }, null, 2))
  } finally {
    await Promise.all(
      Object.values(runners)
        .map((runner) => runner.disconnect)
        .filter((value): value is NonNullable<typeof value> => Boolean(value))
        .map((disconnect) => disconnect())
    )
    await redis.quit()
    await stopRedisContainer()
  }
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
