import type { CacheWriteBehindOptions } from '../types'

type WriteBehindOperation = () => Promise<void>
type FlushWriteBehindBatch = (batch: WriteBehindOperation[]) => Promise<void>
type GenerationCleanupTask = (generation: number) => Promise<void>
type GenerationCleanupErrorHandler = (generation: number, error: unknown) => void

const MAX_KEY_EPOCHS = 50_000

export class CacheStackMaintenance {
  private readonly keyEpochs = new Map<string, number>()
  private readonly writeBehindQueue: WriteBehindOperation[] = []
  private writeBehindTimer?: ReturnType<typeof setInterval>
  private writeBehindFlushPromise?: Promise<void>
  private generationCleanupPromise?: Promise<void>
  private readonly writeChains = new Map<string, Promise<void>>()
  private clearEpoch = 0

  initializeWriteBehindTimer(
    writeStrategy: 'write-through' | 'write-behind' | undefined,
    options: CacheWriteBehindOptions | undefined,
    flush: () => Promise<void>
  ): void {
    if (writeStrategy !== 'write-behind') {
      return
    }

    const flushIntervalMs = options?.flushIntervalMs
    if (!flushIntervalMs || flushIntervalMs <= 0) {
      return
    }

    this.disposeWriteBehindTimer()
    this.writeBehindTimer = setInterval(() => {
      void flush()
    }, flushIntervalMs)
    this.writeBehindTimer.unref?.()
  }

  disposeWriteBehindTimer(): void {
    if (!this.writeBehindTimer) {
      return
    }

    clearInterval(this.writeBehindTimer)
    this.writeBehindTimer = undefined
  }

  beginClearEpoch(): void {
    this.clearEpoch += 1
    this.keyEpochs.clear()
    this.writeBehindQueue.length = 0
  }

  currentClearEpoch(): number {
    return this.clearEpoch
  }

  currentKeyEpoch(key: string): number {
    return this.keyEpochs.get(key) ?? 0
  }

  bumpKeyEpochs(keys: string[]): void {
    for (const key of keys) {
      const nextEpoch = this.currentKeyEpoch(key) + 1
      this.keyEpochs.delete(key)
      this.keyEpochs.set(key, nextEpoch)
    }
    this.pruneKeyEpochsIfNeeded()
  }

  isWriteOutdated(key: string, expectedClearEpoch?: number, expectedKeyEpoch?: number): boolean {
    if (expectedClearEpoch !== undefined && expectedClearEpoch !== this.clearEpoch) {
      return true
    }

    if (expectedKeyEpoch !== undefined && expectedKeyEpoch !== this.currentKeyEpoch(key)) {
      return true
    }

    return false
  }

  async runFencedWrite(
    key: string,
    expectedClearEpoch: number,
    expectedKeyEpoch: number,
    operation: () => Promise<void>,
    cleanup: () => Promise<void>
  ): Promise<boolean> {
    const run = async (): Promise<boolean> => {
      if (this.isWriteOutdated(key, expectedClearEpoch, expectedKeyEpoch)) return false
      await operation()
      if (!this.isWriteOutdated(key, expectedClearEpoch, expectedKeyEpoch)) return true
      await cleanup()
      return false
    }
    const previous = this.writeChains.get(key)
    const result = previous ? previous.catch(() => undefined).then(run) : run()
    const tail = result.then(
      () => undefined,
      () => undefined
    )
    this.writeChains.set(key, tail)
    void tail.finally(() => {
      if (this.writeChains.get(key) === tail) this.writeChains.delete(key)
    })
    return result
  }

  async enqueueWriteBehind(
    operation: WriteBehindOperation,
    options: CacheWriteBehindOptions | undefined,
    flushBatch: FlushWriteBehindBatch
  ): Promise<void> {
    const batchSize = options?.batchSize ?? 100
    const maxQueueSize = options?.maxQueueSize ?? batchSize * 10
    if (this.writeBehindQueue.length >= maxQueueSize) {
      throw new Error(`Write-behind queue limit (${maxQueueSize}) exceeded.`)
    }
    this.writeBehindQueue.push(operation)

    if (this.writeBehindQueue.length >= maxQueueSize) {
      await this.flushWriteBehindQueue(options, flushBatch)
      return
    }

    if (this.writeBehindQueue.length >= batchSize) {
      await this.flushWriteBehindQueue(options, flushBatch)
      return
    }
  }

  async flushWriteBehindQueue(
    options: CacheWriteBehindOptions | undefined,
    flushBatch: FlushWriteBehindBatch
  ): Promise<void> {
    if (this.writeBehindFlushPromise || this.writeBehindQueue.length === 0) {
      await this.writeBehindFlushPromise
      return
    }

    const batchSize = options?.batchSize ?? 100
    const batch = this.writeBehindQueue.splice(0, batchSize)
    this.writeBehindFlushPromise = flushBatch(batch)

    try {
      await this.writeBehindFlushPromise
    } finally {
      this.writeBehindFlushPromise = undefined
    }

    if (this.writeBehindQueue.length > 0) {
      await this.flushWriteBehindQueue(options, flushBatch)
    }
  }

  scheduleGenerationCleanup(
    generation: number,
    task: GenerationCleanupTask,
    onError: GenerationCleanupErrorHandler
  ): void {
    const scheduledTask = (this.generationCleanupPromise ?? Promise.resolve())
      .then(() => task(generation))
      .catch((error) => {
        onError(generation, error)
      })

    this.generationCleanupPromise = scheduledTask.finally(() => {
      if (this.generationCleanupPromise === scheduledTask) {
        this.generationCleanupPromise = undefined
      }
    })
  }

  async waitForGenerationCleanup(): Promise<void> {
    await this.generationCleanupPromise
  }

  private pruneKeyEpochsIfNeeded(): void {
    if (this.keyEpochs.size <= MAX_KEY_EPOCHS) {
      return
    }

    const toDelete = Math.ceil(this.keyEpochs.size * 0.1)
    for (let i = 0; i < toDelete; i++) {
      const oldestKey = this.keyEpochs.keys().next().value
      if (oldestKey === undefined) {
        break
      }
      this.keyEpochs.delete(oldestKey)
    }
  }
}
