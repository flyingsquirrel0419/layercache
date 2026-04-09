import type { CacheRateLimitOptions } from '../types'

interface QueueItem<T> {
  bucketKey: string
  options: NormalizedRateLimitOptions
  task: () => Promise<T>
  resolve: (value: T) => void
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

export class FetchRateLimiter {
  private readonly buckets = new Map<string, BucketState>()
  private readonly queuesByBucket = new Map<string, Array<QueueItem<unknown>>>()
  private readonly pendingBuckets = new Set<string>()
  private readonly fetcherBuckets = new WeakMap<(...args: never[]) => unknown, string>()
  private nextFetcherBucketId = 0
  private drainTimer?: ReturnType<typeof setTimeout>
  private isDisposed = false

  async schedule<T>(
    options: CacheRateLimitOptions | undefined,
    context: ScheduleContext,
    task: () => Promise<T>
  ): Promise<T> {
    if (this.isDisposed) {
      throw new Error('FetchRateLimiter has been disposed.')
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
      const queue = this.queuesByBucket.get(bucketKey) ?? []
      queue.push({
        bucketKey,
        options: normalized,
        task,
        resolve,
        reject
      })
      this.queuesByBucket.set(bucketKey, queue)
      this.pendingBuckets.add(bucketKey)
      this.drain()
    })
  }

  dispose(): void {
    this.isDisposed = true
    if (this.drainTimer) {
      clearTimeout(this.drainTimer)
      this.drainTimer = undefined
    }

    for (const bucket of this.buckets.values()) {
      if (bucket.cleanupTimer) {
        clearTimeout(bucket.cleanupTimer)
        bucket.cleanupTimer = undefined
      }
    }

    for (const queue of this.queuesByBucket.values()) {
      for (const item of queue) {
        item.reject(new Error('FetchRateLimiter has been disposed.'))
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
      bucketKey: options.bucketKey
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
    }

    while (this.pendingBuckets.size > 0) {
      let nextBucketKey: string | undefined
      let nextWaitMs = Number.POSITIVE_INFINITY

      for (const bucketKey of this.pendingBuckets) {
        const queue = this.queuesByBucket.get(bucketKey)
        if (!queue || queue.length === 0) {
          this.pendingBuckets.delete(bucketKey)
          this.queuesByBucket.delete(bucketKey)
          continue
        }

        const next = queue[0]
        if (!next) {
          this.pendingBuckets.delete(bucketKey)
          this.queuesByBucket.delete(bucketKey)
          continue
        }

        const waitMs = this.waitTime(bucketKey, next.options)
        if (waitMs <= 0) {
          nextBucketKey = bucketKey
          break
        }

        nextWaitMs = Math.min(nextWaitMs, waitMs)
      }

      if (!nextBucketKey) {
        if (Number.isFinite(nextWaitMs)) {
          this.drainTimer = setTimeout(() => {
            this.drainTimer = undefined
            this.drain()
          }, nextWaitMs)
          this.drainTimer.unref?.()
        }
        return
      }

      const queue = this.queuesByBucket.get(nextBucketKey)
      const next = queue?.shift()
      if (!next) {
        this.pendingBuckets.delete(nextBucketKey)
        this.queuesByBucket.delete(nextBucketKey)
        continue
      }

      if (!queue || queue.length === 0) {
        this.pendingBuckets.delete(nextBucketKey)
        this.queuesByBucket.delete(nextBucketKey)
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

      void next
        .task()
        .then(next.resolve, next.reject)
        .finally(() => {
          bucket.active -= 1
          if ((this.queuesByBucket.get(next.bucketKey)?.length ?? 0) > 0) {
            this.pendingBuckets.add(next.bucketKey)
          }
          this.cleanupBucket(next.bucketKey, bucket, next.options.intervalMs)
          // Schedule next drain on next tick to prevent recursive event-loop starvation
          if (!this.drainTimer) {
            this.drainTimer = setTimeout(() => {
              this.drainTimer = undefined
              this.drain()
            }, 0)
            this.drainTimer.unref?.()
          }
        })
    }
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
      throw new Error('FetchRateLimiter has been disposed.')
    }

    const existing = this.buckets.get(bucketKey)
    if (existing) {
      return existing
    }

    if (this.buckets.size >= MAX_BUCKETS) {
      this.evictIdleBuckets()
      // Hard limit: if eviction could not free enough space, throw
      if (this.buckets.size >= MAX_BUCKETS) {
        throw new Error(`FetchRateLimiter bucket limit (${MAX_BUCKETS}) exceeded.`)
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
