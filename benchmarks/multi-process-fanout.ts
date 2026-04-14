import { type ChildProcess, fork } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { createRedisClient, ensureRedisContainer, stopRedisContainer, waitForRedisReady } from './redis'

const PROCESS_COUNT = 4
const BURST_CONCURRENCY_PER_PROCESS = 25
const FETCH_DELAY_MS = 25
const COMMAND_TIMEOUT_MS = 200

interface WorkerResponse {
  id: string
  ok: boolean
  result?: unknown
  error?: unknown
}

interface MultiProcessInvalidationResult {
  scenario: string
  success: boolean
  observedVersion: number | null
  latencyMs: number
}

interface MultiProcessFanoutResult {
  scenario: string
  processCount: number
  concurrencyPerProcess: number
  totalConcurrency: number
  latencyMs: number
  originFetchCount: number
}

function spawnWorker(): ChildProcess {
  const workerPath = resolve(process.cwd(), 'benchmarks', 'multi-process-worker.ts')
  return fork(workerPath, [], {
    cwd: process.cwd(),
    execArgv: ['--import', 'tsx'],
    stdio: ['inherit', 'inherit', 'inherit', 'ipc']
  })
}

function sendMessage<T>(worker: ChildProcess, message: Record<string, unknown>): Promise<T> {
  return new Promise((resolve, reject) => {
    const id = String(message.id)

    const onMessage = (response: WorkerResponse): void => {
      if (response.id !== id) {
        return
      }

      worker.off('message', onMessage)
      if (!response.ok) {
        reject(new Error(typeof response.error === 'string' ? response.error : JSON.stringify(response.error)))
        return
      }

      resolve(response.result as T)
    }

    worker.on('message', onMessage)
    worker.send(message)
  })
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

async function runInvalidationScenario(
  workers: ChildProcess[],
  prefix: string
): Promise<MultiProcessInvalidationResult> {
  const busChannel = `${prefix}:bus`
  const sharedPrefix = `${prefix}:invalidate`
  await Promise.all(
    workers.slice(0, 2).map((worker) =>
      sendMessage(worker, {
        id: randomUUID(),
        type: 'init',
        prefix: sharedPrefix,
        busChannel,
        commandTimeoutMs: COMMAND_TIMEOUT_MS
      })
    )
  )

  const writer = workers[0]
  const reader = workers[1]
  if (!writer || !reader) {
    throw new Error('Expected at least two workers for invalidation scenario.')
  }

  await sendMessage(writer, {
    id: randomUUID(),
    type: 'seed',
    key: 'shared:key',
    value: { version: 1 }
  })
  await sendMessage(reader, {
    id: randomUUID(),
    type: 'read',
    key: 'shared:key'
  })

  const startedAt = performance.now()
  await sendMessage(writer, {
    id: randomUUID(),
    type: 'seed',
    key: 'shared:key',
    value: { version: 2 }
  })

  let observedVersion: number | null = null
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const value =
      (await sendMessage<{ version: number } | null>(reader, {
        id: randomUUID(),
        type: 'read',
        key: 'shared:key'
      })) ?? null
    observedVersion = value?.version ?? null
    if (observedVersion === 2) {
      return {
        scenario: 'multi-process-invalidation',
        success: true,
        observedVersion,
        latencyMs: Number((performance.now() - startedAt).toFixed(3))
      }
    }

    await sleep(25)
  }

  return {
    scenario: 'multi-process-invalidation',
    success: false,
    observedVersion,
    latencyMs: Number((performance.now() - startedAt).toFixed(3))
  }
}

async function runDistributedSingleFlightScenario(
  workers: ChildProcess[],
  prefix: string
): Promise<MultiProcessFanoutResult> {
  const redis = createRedisClient()
  const originCounterKey = `${prefix}:origin-count`
  const sharedPrefix = `${prefix}:fanout`
  await redis.del(originCounterKey)

  await Promise.all(
    workers.map((worker) =>
      sendMessage(worker, {
        id: randomUUID(),
        type: 'init',
        prefix: sharedPrefix,
        commandTimeoutMs: COMMAND_TIMEOUT_MS
      }).catch(() => undefined)
    )
  )

  const startedAt = performance.now()
  const startAt = Date.now() + 300
  await Promise.all(
    workers.map((worker) =>
      sendMessage(worker, {
        id: randomUUID(),
        type: 'burst',
        key: 'fanout:key',
        startAt,
        concurrency: BURST_CONCURRENCY_PER_PROCESS,
        originCounterKey,
        fetchDelayMs: FETCH_DELAY_MS
      })
    )
  )
  const originFetchCount = Number(await redis.get(originCounterKey)) || 0
  await redis.quit()

  return {
    scenario: 'multi-process-distributed-single-flight',
    processCount: workers.length,
    concurrencyPerProcess: BURST_CONCURRENCY_PER_PROCESS,
    totalConcurrency: workers.length * BURST_CONCURRENCY_PER_PROCESS,
    latencyMs: Number((performance.now() - startedAt).toFixed(3)),
    originFetchCount
  }
}

async function disposeWorkers(workers: ChildProcess[]): Promise<void> {
  await Promise.all(
    workers.map(async (worker) => {
      try {
        await sendMessage(worker, {
          id: randomUUID(),
          type: 'dispose'
        })
      } catch {
        worker.kill('SIGKILL')
      }
    })
  )
}

async function main(): Promise<void> {
  await ensureRedisContainer()
  await waitForRedisReady()

  const invalidationWorkers = Array.from({ length: 2 }, () => spawnWorker())
  const fanoutWorkers = Array.from({ length: PROCESS_COUNT }, () => spawnWorker())
  const prefix = `layercache-bench:multiprocess:${Date.now()}`

  try {
    const invalidationResult = await runInvalidationScenario(invalidationWorkers, prefix)
    const fanoutResult = await runDistributedSingleFlightScenario(fanoutWorkers, prefix)

    console.table([invalidationResult, fanoutResult])
    console.log(JSON.stringify({ type: 'multi-process-fanout-benchmark', invalidationResult, fanoutResult }, null, 2))
  } finally {
    await disposeWorkers([...invalidationWorkers, ...fanoutWorkers]).catch(() => undefined)
    await stopRedisContainer()
  }
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
