import autocannon, { type Result } from 'autocannon'
import { createRedisClient, ensureRedisContainer, stopRedisContainer, waitForRedisReady } from './redis'
import { startBenchmarkServer } from './server'

interface HttpBenchmarkSummary {
  route: string
  coldStartMs: number
  averageLatencyMs: number
  p97_5LatencyMs: number
  maxLatencyMs: number
  requestsPerSec: number
  throughputBytesPerSec: number
  errors: number
  timeouts: number
}

async function singleRequestLatency(url: string): Promise<number> {
  const startedAt = process.hrtime.bigint()
  const response = await fetch(url)
  await response.arrayBuffer()

  return Number(process.hrtime.bigint() - startedAt) / 1_000_000
}

function runAutocannon(url: string): Promise<Result> {
  return new Promise((resolve, reject) => {
    const instance = autocannon(
      {
        url,
        connections: 40,
        duration: 8,
        pipelining: 1
      },
      (error: Error | null, result: Result) => {
        if (error) {
          reject(error)
          return
        }

        resolve(result)
      }
    )

    instance.on('error', reject)
  })
}

function summarizeHttpRoute(route: string, coldStartMs: number, result: Result): HttpBenchmarkSummary {
  return {
    route,
    coldStartMs: Number(coldStartMs.toFixed(3)),
    averageLatencyMs: Number(result.latency.average.toFixed(3)),
    p97_5LatencyMs: Number(result.latency.p97_5.toFixed(3)),
    maxLatencyMs: Number(result.latency.max.toFixed(3)),
    requestsPerSec: Number(result.requests.average.toFixed(3)),
    throughputBytesPerSec: Number(result.throughput.average.toFixed(3)),
    errors: result.errors,
    timeouts: result.timeouts
  }
}

async function main(): Promise<void> {
  await ensureRedisContainer()

  await waitForRedisReady()
  const redis = createRedisClient()
  await redis.ping()

  const server = await startBenchmarkServer(redis)
  const baseUrl = `http://127.0.0.1:${server.port}`

  try {
    const routes = ['/nocache', '/memory', '/layered']
    const results: HttpBenchmarkSummary[] = []

    for (const route of routes) {
      await server.reset()
      if (route !== '/nocache') {
        await server.warm()
      }

      const coldStartMs = await singleRequestLatency(`${baseUrl}${route}`)
      const result = await runAutocannon(`${baseUrl}${route}`)
      results.push(summarizeHttpRoute(route, coldStartMs, result))
    }

    console.table(results)
    console.log(JSON.stringify({ type: 'http-benchmark', results }, null, 2))
  } finally {
    await server.close()
    await redis.quit()
    await stopRedisContainer()
  }
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
