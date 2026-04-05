import type { CacheRateLimitOptions } from '../types'

interface QueueItem<T> {
  options: CacheRateLimitOptions
  task: () => Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
}

export class FetchRateLimiter {
  private active = 0
  private readonly queue: Array<QueueItem<unknown>> = []
  private readonly startedAt: number[] = []
  private drainTimer?: ReturnType<typeof setTimeout>

  async schedule<T>(options: CacheRateLimitOptions | undefined, task: () => Promise<T>): Promise<T> {
    if (!options) {
      return task()
    }

    const normalized = this.normalize(options)
    if (!normalized) {
      return task()
    }

    return new Promise<T>((resolve, reject) => {
      this.queue.push({ options: normalized, task, resolve, reject })
      this.drain()
    })
  }

  private normalize(options: CacheRateLimitOptions): CacheRateLimitOptions | undefined {
    const maxConcurrent = options.maxConcurrent
    const intervalMs = options.intervalMs
    const maxPerInterval = options.maxPerInterval

    if (!maxConcurrent && !(intervalMs && maxPerInterval)) {
      return undefined
    }

    return {
      maxConcurrent,
      intervalMs,
      maxPerInterval
    }
  }

  private drain(): void {
    if (this.drainTimer) {
      clearTimeout(this.drainTimer)
      this.drainTimer = undefined
    }

    while (this.queue.length > 0) {
      const next = this.queue[0]
      if (!next) {
        return
      }

      const waitMs = this.waitTime(next.options)
      if (waitMs > 0) {
        this.drainTimer = setTimeout(() => {
          this.drainTimer = undefined
          this.drain()
        }, waitMs)
        this.drainTimer.unref?.()
        return
      }

      this.queue.shift()
      this.active += 1
      this.startedAt.push(Date.now())

      void next
        .task()
        .then(next.resolve, next.reject)
        .finally(() => {
          this.active -= 1
          this.drain()
        })
    }
  }

  private waitTime(options: CacheRateLimitOptions): number {
    const now = Date.now()
    if (options.maxConcurrent && this.active >= options.maxConcurrent) {
      return 1
    }

    if (!options.intervalMs || !options.maxPerInterval) {
      return 0
    }

    this.prune(now, options.intervalMs)
    if (this.startedAt.length < options.maxPerInterval) {
      return 0
    }

    const oldest = this.startedAt[0]
    if (!oldest) {
      return 0
    }

    return Math.max(1, options.intervalMs - (now - oldest))
  }

  private prune(now: number, intervalMs: number): void {
    while (this.startedAt.length > 0) {
      const startedAt = this.startedAt[0]
      if (startedAt === undefined || now - startedAt < intervalMs) {
        break
      }
      this.startedAt.shift()
    }
  }
}
