import { type CacheWriteBehindOptions, type CacheWriteCoordinationOptions, CacheWriteSaturationError } from '../types'

type WriteBehindOperation = () => Promise<void>
type FlushWriteBehindBatch = (batch: WriteBehindOperation[]) => Promise<void>
type GenerationCleanupTask = (generation: number) => Promise<void>
type GenerationCleanupErrorHandler = (generation: number, error: unknown) => void

const MAX_KEY_EPOCHS = 50_000
const DEFAULT_MAX_PENDING_WRITES = 10_000
const DEFAULT_MAX_ACTIVE_WRITE_KEYS = 10_000
const DEFAULT_MAX_PENDING_WRITES_PER_KEY = 1_000

export class CacheStackMaintenance {
  private readonly keyEpochs = new Map<string, number>()
  private readonly writeBehindQueue: WriteBehindOperation[] = []
  private writeBehindTimer?: ReturnType<typeof setInterval>
  private writeBehindFlushPromise?: Promise<void>
  private generationCleanupPromise?: Promise<void>
  private readonly writeChains = new Map<string, Promise<void>>()
  private readonly pendingWritesByKey = new Map<string, number>()
  private readonly maxPendingWrites: number
  private readonly maxActiveWriteKeys: number
  private readonly maxPendingWritesPerKey: number
  private pendingWriteUnits = 0
  private nextKeyEpoch = 0
  private absentKeyEpoch = 0
  private clearEpoch = 0

  constructor(options: CacheWriteCoordinationOptions = {}) {
    this.maxPendingWrites = options.maxPendingWrites ?? DEFAULT_MAX_PENDING_WRITES
    this.maxActiveWriteKeys = options.maxActiveKeys ?? DEFAULT_MAX_ACTIVE_WRITE_KEYS
    this.maxPendingWritesPerKey = options.maxPendingWritesPerKey ?? DEFAULT_MAX_PENDING_WRITES_PER_KEY
  }

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
    return this.keyEpochs.get(key) ?? this.absentKeyEpoch
  }

  bumpKeyEpochs(keys: string[]): void {
    for (const key of keys) {
      this.keyEpochs.delete(key)
      this.keyEpochs.set(key, this.allocateKeyEpoch())
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
    return this.runSerializedWrites([key], run)
  }

  async runSerializedWrites<T>(keys: string[], operation: () => Promise<T>): Promise<T> {
    // One shared tail per touched key is the ordering boundary: it keeps bulk
    // and single-key paths from bypassing each other while admission limits
    // bound the promises and key strings retained by that boundary.
    const uniqueKeys = [...new Set(keys)].sort()
    if (uniqueKeys.length === 0) {
      return operation()
    }

    const writeUnits = uniqueKeys.length
    if (this.pendingWriteUnits + writeUnits > this.maxPendingWrites) {
      throw new CacheWriteSaturationError('pending-writes', this.maxPendingWrites)
    }

    const newActiveKeys = uniqueKeys.filter((key) => !this.writeChains.has(key)).length
    if (this.writeChains.size + newActiveKeys > this.maxActiveWriteKeys) {
      throw new CacheWriteSaturationError('active-keys', this.maxActiveWriteKeys)
    }

    for (const key of uniqueKeys) {
      if ((this.pendingWritesByKey.get(key) ?? 0) + 1 > this.maxPendingWritesPerKey) {
        throw new CacheWriteSaturationError('per-key', this.maxPendingWritesPerKey)
      }
    }

    this.pendingWriteUnits += writeUnits
    for (const key of uniqueKeys) {
      this.pendingWritesByKey.set(key, (this.pendingWritesByKey.get(key) ?? 0) + 1)
    }

    const previousTails = [
      ...new Set(
        uniqueKeys.map((key) => this.writeChains.get(key)).filter((tail): tail is Promise<void> => tail !== undefined)
      )
    ]
    const result = Promise.all(previousTails).then(operation)
    const tail = result.then(
      () => undefined,
      () => undefined
    )
    for (const key of uniqueKeys) {
      this.writeChains.set(key, tail)
    }
    void tail.finally(() => {
      this.pendingWriteUnits -= writeUnits
      for (const key of uniqueKeys) {
        const depth = (this.pendingWritesByKey.get(key) ?? 1) - 1
        if (depth === 0) {
          this.pendingWritesByKey.delete(key)
        } else {
          this.pendingWritesByKey.set(key, depth)
        }
        if (this.writeChains.get(key) === tail) this.writeChains.delete(key)
      }
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
    let deleted = 0
    for (let i = 0; i < toDelete; i++) {
      const oldestKey = this.keyEpochs.keys().next().value
      if (oldestKey === undefined) {
        break
      }
      this.keyEpochs.delete(oldestKey)
      deleted += 1
    }
    // Pruned keys become indistinguishable from never-seen keys. Rotating the
    // absent token invalidates any operation holding their old token instead
    // of letting a pruned key pass an ABA-style stale-write check.
    if (deleted > 0) this.absentKeyEpoch = this.allocateKeyEpoch()
  }

  private allocateKeyEpoch(): number {
    if (this.nextKeyEpoch >= Number.MAX_SAFE_INTEGER) {
      this.clearEpoch += 1
      this.keyEpochs.clear()
      this.nextKeyEpoch = 0
      this.absentKeyEpoch = 0
    }
    this.nextKeyEpoch += 1
    return this.nextKeyEpoch
  }
}
