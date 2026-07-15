import type { CacheRateLimitOptions } from '../types'

interface QueueItem {
  bucketKey: string
  options: NormalizedRateLimitOptions
  run: () => Promise<void>
  reject: (error: unknown) => void
}

interface BucketState {
  active: number
  startedAt: number[]
  cleanupTimer?: ReturnType<typeof setTimeout>
}

interface ScheduleContext {
  key: string
  fetcher: (...args: never[]) => unknown
}

interface NormalizedRateLimitOptions extends CacheRateLimitOptions {
  scope: 'global' | 'key' | 'fetcher'
}

const MAX_BUCKETS = 10_000
const MAX_QUEUE_PER_BUCKET = 10_000
const DEFAULT_QUEUE_OVERFLOW_POLICY: NonNullable<CacheRateLimitOptions['queueOverflow']> = 'reject'

export class FetchRateLimitError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FetchRateLimitError'
  }
}

export class FetchRateLimiter {
  private readonly buckets = new Map<string, BucketState>()
  private readonly queuesByBucket = new Map<string, Array<QueueItem>>()
  private readonly pendingBuckets = new Set<string>()
  private readonly fetcherBuckets = new WeakMap<(...args: never[]) => unknown, string>()
  private nextFetcherBucketId = 0
  private drainTimer?: ReturnType<typeof setTimeout>
  private drainTimerDeadline?: number
  private drainScheduled = false
  private isDisposed = false
  rateLimitBypasses = 0

  async schedule<T>(
    options: CacheRateLimitOptions | undefined,
    context: ScheduleContext,
    task: () => Promise<T>
  ): Promise<T> {
    if (this.isDisposed) {
      throw new FetchRateLimitError('FetchRateLimiter has been disposed.')
    }

    if (!options) {
      return task()
    }

    const normalized = this.normalize(options)
    if (!normalized) {
      return task()
    }

    return new Promise<T>((resolve, reject) => {
      const bucketKey = this.resolveBucketKey(normalized, context)
      try {
        this.bucketState(bucketKey)
      } catch (error) {
        reject(error)
        return
      }
      const queue = this.queuesByBucket.get(bucketKey) ?? []
      if (queue.length >= MAX_QUEUE_PER_BUCKET) {
        if ((normalized.queueOverflow ?? DEFAULT_QUEUE_OVERFLOW_POLICY) === 'bypass') {
          this.rateLimitBypasses += 1
          task().then(resolve, reject)
          return
        }
        reject(new FetchRateLimitError(`FetchRateLimiter queue overflow for bucket "${bucketKey}".`))
        return
      }
      queue.push({
        bucketKey,
        options: normalized,
        run: async () => {
          try {
            resolve(await task())
          } catch (error) {
            reject(error)
          }
        },
        reject
      })
      this.queuesByBucket.set(bucketKey, queue)
      this.pendingBuckets.add(bucketKey)
      this.scheduleDrain(0)
    })
  }

  dispose(): void {
    this.isDisposed = true
    if (this.drainTimer) {
      clearTimeout(this.drainTimer)
      this.drainTimer = undefined
      this.drainTimerDeadline = undefined
    }
    this.drainScheduled = false

    for (const bucket of this.buckets.values()) {
      if (bucket.cleanupTimer) {
        clearTimeout(bucket.cleanupTimer)
        bucket.cleanupTimer = undefined
      }
    }

    for (const queue of this.queuesByBucket.values()) {
      for (const item of queue) {
        item.reject(new FetchRateLimitError('FetchRateLimiter has been disposed.'))
      }
    }

    this.queuesByBucket.clear()
    this.pendingBuckets.clear()
    this.buckets.clear()
  }

  private normalize(options: CacheRateLimitOptions): NormalizedRateLimitOptions | undefined {
    const maxConcurrent = options.maxConcurrent
    const intervalMs = options.intervalMs
    const maxPerInterval = options.maxPerInterval

    if (!maxConcurrent && !(intervalMs && maxPerInterval)) {
      return undefined
    }

    return {
      maxConcurrent,
      intervalMs,
      maxPerInterval,
      scope: options.scope ?? 'global',
      bucketKey: options.bucketKey,
      queueOverflow: options.queueOverflow
    }
  }

  private resolveBucketKey(options: NormalizedRateLimitOptions, context: ScheduleContext): string {
    if (options.bucketKey) {
      return `custom:${options.bucketKey}`
    }

    if (options.scope === 'key') {
      return `key:${context.key}`
    }

    if (options.scope === 'fetcher') {
      const existing = this.fetcherBuckets.get(context.fetcher)
      if (existing) {
        return existing
      }

      const bucket = `fetcher:${this.nextFetcherBucketId}`
      this.nextFetcherBucketId += 1
      this.fetcherBuckets.set(context.fetcher, bucket)
      return bucket
    }

    return 'global'
  }

  private drain(): void {
    if (this.isDisposed) {
      return
    }

    if (this.drainTimer) {
      clearTimeout(this.drainTimer)
      this.drainTimer = undefined
      this.drainTimerDeadline = undefined
    }

    let nextWaitMs = Number.POSITIVE_INFINITY
    let startedWork = false

    for (const bucketKey of [...this.pendingBuckets]) {
      const queue = this.queuesByBucket.get(bucketKey)
      if (!queue || queue.length === 0) {
        this.pendingBuckets.delete(bucketKey)
        this.queuesByBucket.delete(bucketKey)
        continue
      }

      const candidate = queue[0]
      if (!candidate) {
        this.pendingBuckets.delete(bucketKey)
        this.queuesByBucket.delete(bucketKey)
        continue
      }

      const waitMs = this.waitTime(bucketKey, candidate.options)
      if (waitMs > 0) {
        nextWaitMs = Math.min(nextWaitMs, waitMs)
        continue
      }

      const next = queue?.shift()
      if (!next) {
        this.pendingBuckets.delete(bucketKey)
        this.queuesByBucket.delete(bucketKey)
        continue
      }

      if (!queue || queue.length === 0) {
        this.pendingBuckets.delete(bucketKey)
        this.queuesByBucket.delete(bucketKey)
      }

      const bucket = this.bucketState(next.bucketKey)
      if (bucket.cleanupTimer) {
        clearTimeout(bucket.cleanupTimer)
        bucket.cleanupTimer = undefined
      }
      bucket.active += 1
      if (next.options.intervalMs && next.options.maxPerInterval) {
        bucket.startedAt.push(Date.now())
      }
      startedWork = true

      void next.run().finally(() => {
        bucket.active -= 1
        if ((this.queuesByBucket.get(next.bucketKey)?.length ?? 0) > 0) {
          this.pendingBuckets.add(next.bucketKey)
        }
        this.cleanupBucket(next.bucketKey, bucket, next.options.intervalMs)
        // Schedule next drain on next tick to prevent recursive event-loop starvation
        this.scheduleDrain(0)
      })
    }

    if (this.pendingBuckets.size > 0) {
      this.scheduleDrain(startedWork ? 0 : nextWaitMs)
    }
  }

  private scheduleDrain(delayMs: number): void {
    if (this.isDisposed || !Number.isFinite(delayMs)) return
    if (delayMs <= 0) {
      if (this.drainTimer) {
        clearTimeout(this.drainTimer)
        this.drainTimer = undefined
        this.drainTimerDeadline = undefined
      }
      if (this.drainScheduled) return
      this.drainScheduled = true
      queueMicrotask(() => {
        this.drainScheduled = false
        this.drain()
      })
      return
    }

    if (this.drainScheduled) return
    const deadline = Date.now() + delayMs
    if (this.drainTimer) {
      // Buckets are independent even though they share a timer. A newly-ready
      // bucket must therefore replace a later deadline chosen by another key.
      if (this.drainTimerDeadline !== undefined && this.drainTimerDeadline <= deadline) return
      clearTimeout(this.drainTimer)
      this.drainTimer = undefined
      this.drainTimerDeadline = undefined
    }

    this.drainTimerDeadline = deadline
    this.drainTimer = setTimeout(
      () => {
        this.drainTimer = undefined
        this.drainTimerDeadline = undefined
        this.drain()
      },
      Math.max(0, deadline - Date.now())
    )
    this.drainTimer.unref?.()
  }

  private waitTime(bucketKey: string, options: NormalizedRateLimitOptions): number {
    const bucket = this.bucketState(bucketKey)
    const now = Date.now()

    if (options.maxConcurrent && bucket.active >= options.maxConcurrent) {
      return 1
    }

    if (!options.intervalMs || !options.maxPerInterval) {
      return 0
    }

    this.prune(bucket, now, options.intervalMs)
    if (bucket.startedAt.length < options.maxPerInterval) {
      return 0
    }

    const oldest = bucket.startedAt[0]
    if (!oldest) {
      return 0
    }

    return Math.max(1, options.intervalMs - (now - oldest))
  }

  private prune(bucket: BucketState, now: number, intervalMs: number): void {
    while (bucket.startedAt.length > 0) {
      const startedAt = bucket.startedAt[0]
      if (startedAt === undefined || now - startedAt < intervalMs) {
        break
      }
      bucket.startedAt.shift()
    }
  }

  private bucketState(bucketKey: string): BucketState {
    if (this.isDisposed) {
      throw new FetchRateLimitError('FetchRateLimiter has been disposed.')
    }

    const existing = this.buckets.get(bucketKey)
    if (existing) {
      return existing
    }

    if (this.buckets.size >= MAX_BUCKETS) {
      this.evictIdleBuckets()
      // Hard limit: if eviction could not free enough space, throw
      if (this.buckets.size >= MAX_BUCKETS) {
        throw new FetchRateLimitError(`FetchRateLimiter bucket limit (${MAX_BUCKETS}) exceeded.`)
      }
    }

    const bucket: BucketState = { active: 0, startedAt: [] }
    this.buckets.set(bucketKey, bucket)
    return bucket
  }

  private evictIdleBuckets(): void {
    for (const [key, bucket] of this.buckets.entries()) {
      if (this.buckets.size <= MAX_BUCKETS * 0.9) {
        break
      }
      if (bucket.active === 0 && bucket.startedAt.length === 0 && !this.queuesByBucket.has(key)) {
        this.buckets.delete(key)
        this.queuesByBucket.delete(key)
        this.pendingBuckets.delete(key)
      }
    }
  }

  private cleanupBucket(bucketKey: string, bucket: BucketState, intervalMs: number | undefined): void {
    const queued = this.queuesByBucket.get(bucketKey)?.length ?? 0
    if (queued === 0 && bucket.active === 0 && bucket.startedAt.length === 0) {
      this.buckets.delete(bucketKey)
      this.queuesByBucket.delete(bucketKey)
      this.pendingBuckets.delete(bucketKey)
      return
    }

    if (!intervalMs || bucket.active > 0 || queued > 0) {
      return
    }

    if (bucket.cleanupTimer) {
      clearTimeout(bucket.cleanupTimer)
    }

    bucket.cleanupTimer = setTimeout(() => {
      bucket.cleanupTimer = undefined
      this.prune(bucket, Date.now(), intervalMs)
      if (
        bucket.active === 0 &&
        bucket.startedAt.length === 0 &&
        (this.queuesByBucket.get(bucketKey)?.length ?? 0) === 0
      ) {
        this.buckets.delete(bucketKey)
        this.queuesByBucket.delete(bucketKey)
        this.pendingBuckets.delete(bucketKey)
      }
    }, intervalMs)
    bucket.cleanupTimer.unref?.()
  }
}
