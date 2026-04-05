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
}

interface ScheduleContext {
  key: string
  fetcher: (...args: never[]) => unknown
}

interface NormalizedRateLimitOptions extends CacheRateLimitOptions {
  scope: 'global' | 'key' | 'fetcher'
}

export class FetchRateLimiter {
  private readonly queue: Array<QueueItem<unknown>> = []
  private readonly buckets = new Map<string, BucketState>()
  private readonly fetcherBuckets = new WeakMap<(...args: never[]) => unknown, string>()
  private nextFetcherBucketId = 0
  private drainTimer?: ReturnType<typeof setTimeout>

  async schedule<T>(
    options: CacheRateLimitOptions | undefined,
    context: ScheduleContext,
    task: () => Promise<T>
  ): Promise<T> {
    if (!options) {
      return task()
    }

    const normalized = this.normalize(options)
    if (!normalized) {
      return task()
    }

    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        bucketKey: this.resolveBucketKey(normalized, context),
        options: normalized,
        task,
        resolve,
        reject
      })
      this.drain()
    })
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
    if (this.drainTimer) {
      clearTimeout(this.drainTimer)
      this.drainTimer = undefined
    }

    while (this.queue.length > 0) {
      let nextIndex = -1
      let nextWaitMs = Number.POSITIVE_INFINITY

      for (let index = 0; index < this.queue.length; index += 1) {
        const next = this.queue[index]
        if (!next) {
          continue
        }

        const waitMs = this.waitTime(next.bucketKey, next.options)
        if (waitMs <= 0) {
          nextIndex = index
          break
        }

        nextWaitMs = Math.min(nextWaitMs, waitMs)
      }

      if (nextIndex < 0) {
        if (Number.isFinite(nextWaitMs)) {
          this.drainTimer = setTimeout(() => {
            this.drainTimer = undefined
            this.drain()
          }, nextWaitMs)
          this.drainTimer.unref?.()
        }
        return
      }

      const next = this.queue.splice(nextIndex, 1)[0]
      if (!next) {
        return
      }

      const bucket = this.bucketState(next.bucketKey)
      bucket.active += 1
      bucket.startedAt.push(Date.now())

      void next
        .task()
        .then(next.resolve, next.reject)
        .finally(() => {
          bucket.active -= 1
          this.drain()
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
    const existing = this.buckets.get(bucketKey)
    if (existing) {
      return existing
    }

    const bucket: BucketState = { active: 0, startedAt: [] }
    this.buckets.set(bucketKey, bucket)
    return bucket
  }
}
