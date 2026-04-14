import { PerformanceObserver, monitorEventLoopDelay } from 'node:perf_hooks'
import { CacheStack, MemoryLayer, RedisLayer } from '../src'
import { createRedisClient, ensureRedisContainer, stopRedisContainer, waitForRedisReady } from './redis'
import { summarizeGcMetrics } from './slow-redis-utils'

const EVICTION_CAPACITY = 25
const EVICTION_KEYS = 180
const EVICTION_PAYLOAD_BYTES = 256 * 1024
const REVISIT_COUNT = 25

interface MemoryPressureResult {
  scenario: string
  maxSize: number
  uniqueKeys: number
  evictions: number
  l1RetainedKeys: number
  revisitAvgMs: number
  revisitP95Ms: number
  revisitOriginFetches: number
  gcCount: number
  gcTotalMs: number
  gcMaxMs: number
  eventLoopMaxMs: number
  heapDeltaMb: number
}

function round(value: number): number {
  return Number(value.toFixed(3))
}

function buildLargePayload(bytes: number): { size: number; payload: string } {
  return {
    size: bytes,
    payload: 'p'.repeat(bytes)
  }
}

async function measure<TResult>(task: () => Promise<TResult>): Promise<{ durationMs: number; result: TResult }> {
  const startedAt = process.hrtime.bigint()
  const result = await task()

  return {
    durationMs: Number(process.hrtime.bigint() - startedAt) / 1_000_000,
    result
  }
}

async function main(): Promise<void> {
  await ensureRedisContainer()
  await waitForRedisReady()

  const redis = createRedisClient()
  await redis.ping()

  const gcDurations: number[] = []
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      gcDurations.push(entry.duration)
    }
  })
  observer.observe({ entryTypes: ['gc'] })

  const loopDelay = monitorEventLoopDelay({ resolution: 10 })
  loopDelay.enable()

  let evictions = 0
  const memoryLayer = new MemoryLayer({
    ttl: 60,
    maxSize: EVICTION_CAPACITY,
    onEvict: () => {
      evictions += 1
    }
  })

  const cache = new CacheStack([
    memoryLayer,
    new RedisLayer({ client: redis, ttl: 300, prefix: 'pressure:benchmark:' })
  ])

  const heapBeforeMb = process.memoryUsage().heapUsed / (1024 * 1024)

  try {
    await cache.clear()
    await redis.flushdb()

    for (let index = 0; index < EVICTION_KEYS; index += 1) {
      await cache.get(`pressure:${index}`, async () => ({ key: index, ...buildLargePayload(EVICTION_PAYLOAD_BYTES) }), {
        ttl: 60
      })
    }

    const retainedKeys = memoryLayer.exportState().length
    let revisitOriginFetches = 0
    const revisitSamples: number[] = []

    for (let index = 0; index < REVISIT_COUNT; index += 1) {
      const { durationMs } = await measure(() =>
        cache.get(
          `pressure:${index}`,
          async () => {
            revisitOriginFetches += 1
            return { key: index, ...buildLargePayload(EVICTION_PAYLOAD_BYTES) }
          },
          { ttl: 60 }
        )
      )
      revisitSamples.push(durationMs)
    }

    const sortedSamples = [...revisitSamples].sort((left, right) => left - right)
    const gcSummary = summarizeGcMetrics(gcDurations)
    const heapAfterMb = process.memoryUsage().heapUsed / (1024 * 1024)

    const result: MemoryPressureResult = {
      scenario: 'memory-pressure-eviction',
      maxSize: EVICTION_CAPACITY,
      uniqueKeys: EVICTION_KEYS,
      evictions,
      l1RetainedKeys: retainedKeys,
      revisitAvgMs: round(revisitSamples.reduce((sum, sample) => sum + sample, 0) / revisitSamples.length),
      revisitP95Ms: round(sortedSamples[Math.ceil(sortedSamples.length * 0.95) - 1] ?? 0),
      revisitOriginFetches,
      gcCount: gcSummary.gcCount,
      gcTotalMs: gcSummary.gcTotalMs,
      gcMaxMs: gcSummary.gcMaxMs,
      eventLoopMaxMs: round(loopDelay.max / 1_000_000),
      heapDeltaMb: round(heapAfterMb - heapBeforeMb)
    }

    console.table([result])
    console.log(JSON.stringify({ type: 'memory-pressure', result }, null, 2))
  } finally {
    loopDelay.disable()
    observer.disconnect()
    await cache.disconnect().catch(() => {})
    await redis.quit().catch(() => {})
    await stopRedisContainer()
  }
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
