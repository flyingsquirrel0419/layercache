import { afterEach, describe, expect, it, vi } from 'vitest'
import { CacheStackMaintenance } from '../../src/internal/CacheStackMaintenance'

describe('CacheStackMaintenance', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('tracks key epochs and clears queued write-behind work when a clear epoch begins', async () => {
    const maintenance = new CacheStackMaintenance()
    const executed: string[] = []
    const flushBatch = vi.fn(async (batch: Array<() => Promise<void>>) => {
      for (const operation of batch) {
        await operation()
      }
    })

    expect(maintenance.currentKeyEpoch('user:1')).toBe(0)
    expect(maintenance.isWriteOutdated('user:1', 0, 0)).toBe(false)

    maintenance.bumpKeyEpochs(['user:1'])
    expect(maintenance.currentKeyEpoch('user:1')).toBe(1)
    expect(maintenance.isWriteOutdated('user:1', 0, 0)).toBe(true)
    expect(maintenance.isWriteOutdated('user:1', 0, 1)).toBe(false)

    await maintenance.enqueueWriteBehind(
      async () => {
        executed.push('stale')
      },
      { batchSize: 10 },
      flushBatch
    )

    maintenance.beginClearEpoch()

    expect(maintenance.isWriteOutdated('user:1', 0, 1)).toBe(true)
    expect(maintenance.currentKeyEpoch('user:1')).toBe(0)

    await maintenance.flushWriteBehindQueue({ batchSize: 10 }, flushBatch)

    expect(flushBatch).not.toHaveBeenCalled()
    expect(executed).toEqual([])
  })

  it('flushes queued write-behind operations once queue thresholds are reached', async () => {
    const maintenance = new CacheStackMaintenance()
    const executed: string[] = []
    const flushBatch = vi.fn(async (batch: Array<() => Promise<void>>) => {
      for (const operation of batch) {
        await operation()
      }
    })

    await maintenance.enqueueWriteBehind(
      async () => {
        executed.push('first')
      },
      { batchSize: 2, maxQueueSize: 3 },
      flushBatch
    )

    expect(flushBatch).not.toHaveBeenCalled()

    await maintenance.enqueueWriteBehind(
      async () => {
        executed.push('second')
      },
      { batchSize: 2, maxQueueSize: 3 },
      flushBatch
    )

    expect(flushBatch).toHaveBeenCalledTimes(1)
    expect(executed).toEqual(['first', 'second'])
  })

  it('flushes on max queue pressure and drains multi-batch queues recursively', async () => {
    const maintenance = new CacheStackMaintenance()
    const executed: string[] = []
    const batchSizes: number[] = []
    const flushBatch = vi.fn(async (batch: Array<() => Promise<void>>) => {
      batchSizes.push(batch.length)
      for (const operation of batch) {
        await operation()
      }
    })

    await maintenance.enqueueWriteBehind(
      async () => {
        executed.push('pressure-1')
      },
      { batchSize: 5, maxQueueSize: 2 },
      flushBatch
    )
    await maintenance.enqueueWriteBehind(
      async () => {
        executed.push('pressure-2')
      },
      { batchSize: 5, maxQueueSize: 2 },
      flushBatch
    )

    expect(batchSizes).toEqual([2])

    await maintenance.enqueueWriteBehind(
      async () => {
        executed.push('drain-1')
      },
      { batchSize: 2, maxQueueSize: 10 },
      flushBatch
    )
    await maintenance.enqueueWriteBehind(
      async () => {
        executed.push('drain-2')
      },
      { batchSize: 2, maxQueueSize: 10 },
      flushBatch
    )
    await maintenance.enqueueWriteBehind(
      async () => {
        executed.push('drain-3')
      },
      { batchSize: 2, maxQueueSize: 10 },
      flushBatch
    )

    await maintenance.flushWriteBehindQueue({ batchSize: 2, maxQueueSize: 10 }, flushBatch)

    expect(batchSizes).toEqual([2, 2, 1])
    expect(executed).toEqual(['pressure-1', 'pressure-2', 'drain-1', 'drain-2', 'drain-3'])
  })

  it('serializes concurrent write-behind flushes against the same in-flight batch', async () => {
    const maintenance = new CacheStackMaintenance()
    const executed: string[] = []
    let releaseBatch!: () => void
    const batchReleased = new Promise<void>((resolve) => {
      releaseBatch = resolve
    })
    const flushBatch = vi.fn(async (batch: Array<() => Promise<void>>) => {
      await batchReleased
      for (const operation of batch) {
        await operation()
      }
    })

    await maintenance.enqueueWriteBehind(
      async () => {
        executed.push('one')
      },
      { batchSize: 10 },
      flushBatch
    )
    await maintenance.enqueueWriteBehind(
      async () => {
        executed.push('two')
      },
      { batchSize: 10 },
      flushBatch
    )

    const firstFlush = maintenance.flushWriteBehindQueue({ batchSize: 10 }, flushBatch)
    const secondFlush = maintenance.flushWriteBehindQueue({ batchSize: 10 }, flushBatch)

    await Promise.resolve()
    expect(flushBatch).toHaveBeenCalledTimes(1)

    releaseBatch()
    await Promise.all([firstFlush, secondFlush])

    expect(executed).toEqual(['one', 'two'])
  })

  it('rejects queue overflow during an active flush and drains retained work afterward', async () => {
    const maintenance = new CacheStackMaintenance()
    let releaseFlush!: () => void
    const flushGate = new Promise<void>((resolve) => {
      releaseFlush = resolve
    })
    const executed: string[] = []
    let flushes = 0
    const flushBatch = vi.fn(async (batch: Array<() => Promise<void>>) => {
      flushes += 1
      if (flushes === 1) await flushGate
      for (const operation of batch) await operation()
    })

    await maintenance.enqueueWriteBehind(
      async () => {
        executed.push('first')
      },
      { batchSize: 10, maxQueueSize: 2 },
      flushBatch
    )
    const activeFlush = maintenance.flushWriteBehindQueue({ batchSize: 10, maxQueueSize: 2 }, flushBatch)
    await Promise.resolve()
    await maintenance.enqueueWriteBehind(
      async () => {
        executed.push('second')
      },
      { batchSize: 10, maxQueueSize: 2 },
      flushBatch
    )
    const pressureFlush = maintenance.enqueueWriteBehind(
      async () => {
        executed.push('third')
      },
      { batchSize: 10, maxQueueSize: 2 },
      flushBatch
    )

    await expect(
      maintenance.enqueueWriteBehind(
        async () => {
          executed.push('overflow')
        },
        { batchSize: 10, maxQueueSize: 2 },
        flushBatch
      )
    ).rejects.toThrow(/queue limit/i)

    releaseFlush()
    await Promise.all([activeFlush, pressureFlush])
    expect(executed).toEqual(['first', 'second', 'third'])
    expect(flushBatch).toHaveBeenCalledTimes(2)
  })

  it('runs generation cleanup sequentially and continues after reported failures', async () => {
    const maintenance = new CacheStackMaintenance()
    const order: string[] = []
    const reportedErrors: Array<{ generation: number; message: string }> = []
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })

    maintenance.scheduleGenerationCleanup(
      1,
      async (generation) => {
        order.push(`start:${generation}`)
        await firstGate
        order.push(`end:${generation}`)
      },
      (generation, error) => {
        reportedErrors.push({ generation, message: error instanceof Error ? error.message : String(error) })
      }
    )
    maintenance.scheduleGenerationCleanup(
      2,
      async (generation) => {
        order.push(`run:${generation}`)
      },
      (generation, error) => {
        reportedErrors.push({ generation, message: error instanceof Error ? error.message : String(error) })
      }
    )

    await Promise.resolve()
    expect(order).toEqual(['start:1'])

    releaseFirst()
    await maintenance.waitForGenerationCleanup()

    expect(order).toEqual(['start:1', 'end:1', 'run:2'])

    maintenance.scheduleGenerationCleanup(
      3,
      async () => {
        throw new Error('cleanup failed')
      },
      (generation, error) => {
        reportedErrors.push({ generation, message: error instanceof Error ? error.message : String(error) })
      }
    )
    maintenance.scheduleGenerationCleanup(
      4,
      async (generation) => {
        order.push(`run:${generation}`)
      },
      (generation, error) => {
        reportedErrors.push({ generation, message: error instanceof Error ? error.message : String(error) })
      }
    )

    await maintenance.waitForGenerationCleanup()

    expect(reportedErrors).toEqual([{ generation: 3, message: 'cleanup failed' }])
    expect(order).toEqual(['start:1', 'end:1', 'run:2', 'run:4'])
  })

  describe('pruneKeyEpochsIfNeeded', () => {
    it('keeps keyEpochs bounded when exceeding MAX_KEY_EPOCHS', () => {
      const maintenance = new CacheStackMaintenance()
      const keyEpochs = (maintenance as unknown as { keyEpochs: Map<string, number> }).keyEpochs

      const keys = Array.from({ length: 50_001 }, (_, i) => `key:${i}`)
      maintenance.bumpKeyEpochs(keys)

      expect(keyEpochs.size).toBeLessThanOrEqual(50_000)
      expect(keyEpochs.size).toBeGreaterThan(40_000)
    })

    it('removes lowest-epoch keys when pruning', () => {
      const maintenance = new CacheStackMaintenance()
      const keyEpochs = (maintenance as unknown as { keyEpochs: Map<string, number> }).keyEpochs

      for (let i = 0; i < 25_000; i++) {
        keyEpochs.set(`old:${i}`, 1)
      }
      for (let i = 0; i < 25_001; i++) {
        keyEpochs.set(`new:${i}`, 100)
      }

      maintenance.bumpKeyEpochs(['trigger'])

      let oldRemaining = 0
      for (let i = 0; i < 25_000; i++) {
        if (keyEpochs.has(`old:${i}`)) oldRemaining++
      }
      expect(oldRemaining).toBeLessThan(25_000)

      for (let i = 0; i < 25_001; i++) {
        expect(keyEpochs.has(`new:${i}`)).toBe(true)
      }
    })

    it('prunes key epochs without sorting the full epoch map', () => {
      const maintenance = new CacheStackMaintenance()
      const keyEpochs = (maintenance as unknown as { keyEpochs: Map<string, number> }).keyEpochs
      const sort = vi.spyOn(Array.prototype, 'sort')

      for (let i = 0; i < 50_001; i++) {
        keyEpochs.set(`key:${i}`, i)
      }

      maintenance.bumpKeyEpochs(['trigger'])

      expect(sort).not.toHaveBeenCalled()
      sort.mockRestore()
    })
  })

  it('starts and stops the write-behind timer only for write-behind mode with a positive interval', async () => {
    vi.useFakeTimers()

    const maintenance = new CacheStackMaintenance()
    const flush = vi.fn(async () => undefined)

    maintenance.initializeWriteBehindTimer('write-through', { flushIntervalMs: 25 }, flush)
    await vi.advanceTimersByTimeAsync(50)
    expect(flush).not.toHaveBeenCalled()

    maintenance.initializeWriteBehindTimer('write-behind', { flushIntervalMs: 0 }, flush)
    await vi.advanceTimersByTimeAsync(50)
    expect(flush).not.toHaveBeenCalled()

    maintenance.initializeWriteBehindTimer('write-behind', { flushIntervalMs: 25 }, flush)
    await vi.advanceTimersByTimeAsync(26)
    expect(flush).toHaveBeenCalledTimes(1)

    maintenance.disposeWriteBehindTimer()
    await vi.advanceTimersByTimeAsync(100)
    expect(flush).toHaveBeenCalledTimes(1)
  })
})
