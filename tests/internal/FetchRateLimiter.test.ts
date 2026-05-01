import { describe, expect, it, vi } from 'vitest'
import { FetchRateLimiter } from '../../src/internal/FetchRateLimiter'

describe('FetchRateLimiter', () => {
  it('normalizes options and resolves bucket keys for each scope', () => {
    const limiter = new FetchRateLimiter()
    const fetcher = async () => 'shared'

    expect(
      (limiter as unknown as { normalize: (options: Record<string, unknown>) => unknown }).normalize({})
    ).toBeUndefined()
    expect(
      (
        limiter as unknown as {
          resolveBucketKey: (
            options: Record<string, unknown>,
            context: { key: string; fetcher: typeof fetcher }
          ) => string
        }
      ).resolveBucketKey({ scope: 'global' }, { key: 'user:1', fetcher })
    ).toBe('global')
    expect(
      (
        limiter as unknown as {
          resolveBucketKey: (
            options: Record<string, unknown>,
            context: { key: string; fetcher: typeof fetcher }
          ) => string
        }
      ).resolveBucketKey({ scope: 'key' }, { key: 'user:1', fetcher })
    ).toBe('key:user:1')
    expect(
      (
        limiter as unknown as {
          resolveBucketKey: (
            options: Record<string, unknown>,
            context: { key: string; fetcher: typeof fetcher }
          ) => string
        }
      ).resolveBucketKey({ bucketKey: 'tenant:a', scope: 'global' }, { key: 'user:1', fetcher })
    ).toBe('custom:tenant:a')

    const first = (
      limiter as unknown as {
        resolveBucketKey: (
          options: Record<string, unknown>,
          context: { key: string; fetcher: typeof fetcher }
        ) => string
      }
    ).resolveBucketKey({ scope: 'fetcher' }, { key: 'user:1', fetcher })
    const second = (
      limiter as unknown as {
        resolveBucketKey: (
          options: Record<string, unknown>,
          context: { key: string; fetcher: typeof fetcher }
        ) => string
      }
    ).resolveBucketKey({ scope: 'fetcher' }, { key: 'user:2', fetcher })

    expect(first).toBe(second)
  })

  it('runs tasks immediately when no limits are configured', async () => {
    const limiter = new FetchRateLimiter()
    const task = vi.fn(async () => 'ok')

    await expect(limiter.schedule(undefined, { key: 'user:1', fetcher: async () => 'x' }, task)).resolves.toBe('ok')
    expect(task).toHaveBeenCalledTimes(1)
  })

  it('scopes buckets by key fetcher and custom identifiers', async () => {
    const limiter = new FetchRateLimiter()
    const fetcher = async () => 'shared'

    await Promise.all([
      limiter.schedule({ maxConcurrent: 1, scope: 'fetcher' }, { key: 'a', fetcher }, async () => 'a'),
      limiter.schedule({ maxConcurrent: 1, scope: 'fetcher' }, { key: 'b', fetcher }, async () => 'b'),
      limiter.schedule(
        { maxConcurrent: 1, bucketKey: 'tenant:a' },
        { key: 'c', fetcher: async () => 'c' },
        async () => 'c'
      )
    ])

    const fetcherBuckets = (limiter as unknown as { fetcherBuckets: WeakMap<(...args: never[]) => unknown, string> })
      .fetcherBuckets
    expect(fetcherBuckets.get(fetcher)).toContain('fetcher:')
  })

  it('cleans up empty scoped buckets after scheduled work completes', async () => {
    const limiter = new FetchRateLimiter()

    await Promise.all([
      limiter.schedule({ maxConcurrent: 1, scope: 'key' }, { key: 'a', fetcher: async () => 'a' }, async () => 'a'),
      limiter.schedule({ maxConcurrent: 1, scope: 'key' }, { key: 'b', fetcher: async () => 'b' }, async () => 'b')
    ])

    const buckets = (limiter as unknown as { buckets: Map<string, unknown> }).buckets
    expect(buckets.size).toBe(0)
  })

  it('cleans up interval buckets after the rate-limit window passes', async () => {
    vi.useFakeTimers()
    const limiter = new FetchRateLimiter()

    try {
      await limiter.schedule(
        { intervalMs: 10, maxPerInterval: 1, scope: 'key' },
        { key: 'user:1', fetcher: async () => 'a' },
        async () => 'a'
      )

      await vi.advanceTimersByTimeAsync(10)

      const buckets = (limiter as unknown as { buckets: Map<string, unknown> }).buckets
      expect(buckets.size).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('returns a positive wait time while the interval window is still active', () => {
    vi.useFakeTimers()
    const limiter = new FetchRateLimiter()

    try {
      const now = Date.now()
      const bucket = { active: 0, startedAt: [now - 25], cleanupTimer: undefined }
      ;(limiter as unknown as { buckets: Map<string, typeof bucket> }).buckets.set('global', bucket)

      expect(
        (
          limiter as unknown as {
            waitTime: (bucketKey: string, options: Record<string, unknown>) => number
          }
        ).waitTime('global', { intervalMs: 100, maxPerInterval: 1 })
      ).toBe(75)
    } finally {
      vi.useRealTimers()
    }
  })

  it('respects maxConcurrent limits and drains queued work later', async () => {
    vi.useFakeTimers()
    try {
      const limiter = new FetchRateLimiter()
      const order: string[] = []
      let release: (() => void) | undefined

      const first = limiter.schedule(
        { maxConcurrent: 1, scope: 'global' },
        { key: 'user:1', fetcher: async () => 'a' },
        () =>
          new Promise<string>((resolve) => {
            order.push('first-start')
            release = () => resolve('a')
          })
      )
      const second = limiter.schedule(
        { maxConcurrent: 1, scope: 'global' },
        { key: 'user:2', fetcher: async () => 'b' },
        async () => {
          order.push('second-start')
          return 'b'
        }
      )

      await vi.advanceTimersByTimeAsync(1)
      expect(order).toEqual(['first-start'])

      release?.()
      await expect(first).resolves.toBe('a')
      // drain() schedules via setTimeout(0) after task completion, advance to trigger it
      await vi.advanceTimersByTimeAsync(1)
      await expect(second).resolves.toBe('b')
      expect(order).toEqual(['first-start', 'second-start'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('clears an existing cleanup timer when rearming an interval bucket', () => {
    vi.useFakeTimers()
    const limiter = new FetchRateLimiter()
    const clearTimeoutSpy = vi.spyOn(global, 'clearTimeout')
    const bucket = {
      active: 0,
      startedAt: [Date.now()],
      cleanupTimer: setTimeout(() => undefined, 1_000)
    }
    ;(limiter as unknown as { buckets: Map<string, typeof bucket> }).buckets.set('global', bucket)

    try {
      ;(
        limiter as unknown as {
          cleanupBucket: (bucketKey: string, state: typeof bucket, intervalMs: number | undefined) => void
        }
      ).cleanupBucket('global', bucket, 10)

      expect(clearTimeoutSpy).toHaveBeenCalledTimes(1)
      expect(bucket.cleanupTimer).toBeDefined()
    } finally {
      clearTimeoutSpy.mockRestore()
      vi.clearAllTimers()
      vi.useRealTimers()
    }
  })

  it('evicts idle buckets when the internal bucket map grows too large', async () => {
    const limiter = new FetchRateLimiter()
    const buckets = (limiter as unknown as { buckets: Map<string, { active: number; startedAt: number[] }> }).buckets

    for (let index = 0; index < 10_001; index += 1) {
      buckets.set(`key:${index}`, { active: 0, startedAt: [] })
    }

    await limiter.schedule(
      { maxConcurrent: 1, scope: 'key' },
      { key: 'fresh', fetcher: async () => 'x' },
      async () => 'ok'
    )

    expect(buckets.size).toBeLessThanOrEqual(9_001)
  })

  it('computes wait times, prunes windows, and cleans up buckets', async () => {
    vi.useFakeTimers()
    const limiter = new FetchRateLimiter()

    try {
      const bucket = { active: 1, startedAt: [Date.now() - 20, Date.now()], cleanupTimer: undefined }
      ;(limiter as unknown as { buckets: Map<string, typeof bucket> }).buckets.set('global', bucket)

      expect(
        (
          limiter as unknown as {
            waitTime: (bucketKey: string, options: Record<string, unknown>) => number
          }
        ).waitTime('global', { maxConcurrent: 1 })
      ).toBe(1)

      bucket.active = 0
      expect(
        (
          limiter as unknown as {
            waitTime: (bucketKey: string, options: Record<string, unknown>) => number
          }
        ).waitTime('global', { intervalMs: 100, maxPerInterval: 5 })
      ).toBe(0)

      bucket.startedAt = [undefined as unknown as number]
      expect(
        (
          limiter as unknown as {
            waitTime: (bucketKey: string, options: Record<string, unknown>) => number
          }
        ).waitTime('global', { intervalMs: 100, maxPerInterval: 1 })
      ).toBe(0)

      bucket.startedAt = [Date.now() - 200, Date.now() - 50]
      ;(
        limiter as unknown as {
          prune: (state: typeof bucket, now: number, intervalMs: number) => void
        }
      ).prune(bucket, Date.now(), 100)
      expect(bucket.startedAt).toHaveLength(1)
      ;(
        limiter as unknown as {
          cleanupBucket: (bucketKey: string, state: typeof bucket, intervalMs: number | undefined) => void
        }
      ).cleanupBucket('global', { active: 0, startedAt: [], cleanupTimer: undefined }, undefined)
      expect((limiter as unknown as { buckets: Map<string, unknown> }).buckets.has('global')).toBe(false)

      const delayed = { active: 0, startedAt: [Date.now()], cleanupTimer: undefined }
      ;(limiter as unknown as { buckets: Map<string, typeof delayed> }).buckets.set('delayed', delayed)
      ;(
        limiter as unknown as {
          cleanupBucket: (bucketKey: string, state: typeof delayed, intervalMs: number | undefined) => void
        }
      ).cleanupBucket('delayed', delayed, 10)
      expect(delayed.cleanupTimer).toBeDefined()
      await vi.advanceTimersByTimeAsync(10)
      expect((limiter as unknown as { buckets: Map<string, unknown> }).buckets.has('delayed')).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('bypasses rate limiting when a bucket queue exceeds MAX_QUEUE_PER_BUCKET', async () => {
    const limiter = new FetchRateLimiter()
    const queuesByBucket = (limiter as unknown as { queuesByBucket: Map<string, Array<unknown>> }).queuesByBucket

    queuesByBucket.set(
      'key:user:1',
      Array.from({ length: 10_000 }, () => ({}))
    )

    expect(limiter.rateLimitBypasses).toBe(0)

    const result = await limiter.schedule(
      { maxConcurrent: 1, scope: 'key' },
      { key: 'user:1', fetcher: async () => 'x' },
      async () => 'bypassed'
    )

    expect(result).toBe('bypassed')
    expect(limiter.rateLimitBypasses).toBe(1)
  })

  it('disposes timers and rejects future scheduling', async () => {
    vi.useFakeTimers()
    const limiter = new FetchRateLimiter()

    try {
      await limiter.schedule(
        { intervalMs: 10, maxPerInterval: 1, scope: 'key' },
        { key: 'user:1', fetcher: async () => 'a' },
        async () => 'a'
      )

      const bucket = (
        limiter as unknown as { buckets: Map<string, { cleanupTimer?: ReturnType<typeof setTimeout> }> }
      ).buckets.get('key:user:1')
      expect(bucket?.cleanupTimer).toBeDefined()

      limiter.dispose()

      expect((limiter as unknown as { buckets: Map<string, unknown> }).buckets.size).toBe(0)
      await expect(
        limiter.schedule({ maxConcurrent: 1 }, { key: 'user:2', fetcher: async () => 'b' }, async () => 'b')
      ).rejects.toThrow(/disposed/i)
    } finally {
      vi.useRealTimers()
    }
  })

  it('runs the task when normalized options do not contain active limits', async () => {
    const limiter = new FetchRateLimiter()
    const task = vi.fn(async () => 'unlimited')

    await expect(
      limiter.schedule({ scope: 'global' }, { key: 'user:1', fetcher: async () => 'x' }, task)
    ).resolves.toBe('unlimited')

    expect(task).toHaveBeenCalledTimes(1)
  })

  it('rejects queued work when disposed before the active task drains it', async () => {
    const limiter = new FetchRateLimiter()
    let releaseFirst!: () => void

    const first = limiter.schedule(
      { maxConcurrent: 1 },
      { key: 'a', fetcher: async () => 'a' },
      () =>
        new Promise<string>((resolve) => {
          releaseFirst = () => resolve('first')
        })
    )
    const second = limiter.schedule({ maxConcurrent: 1 }, { key: 'b', fetcher: async () => 'b' }, async () => 'second')

    await Promise.resolve()
    limiter.dispose()
    releaseFirst()

    await expect(first).resolves.toBe('first')
    await expect(second).rejects.toThrow(/disposed/i)
  })

  it('drops empty and sparse pending queues during drain', async () => {
    const limiter = new FetchRateLimiter()
    const queuesByBucket = (limiter as unknown as { queuesByBucket: Map<string, Array<unknown>> }).queuesByBucket
    const pendingBuckets = (limiter as unknown as { pendingBuckets: Set<string> }).pendingBuckets

    queuesByBucket.set('empty', [])
    queuesByBucket.set('sparse', new Array(1))
    pendingBuckets.add('empty')
    pendingBuckets.add('sparse')
    ;(limiter as unknown as { drain: () => void }).drain()

    expect(queuesByBucket.size).toBe(0)
    expect(pendingBuckets.size).toBe(0)
  })

  it('throws when the bucket hard limit cannot be relieved by idle eviction', () => {
    const limiter = new FetchRateLimiter()
    const buckets = (limiter as unknown as { buckets: Map<string, { active: number; startedAt: number[] }> }).buckets

    for (let index = 0; index < 10_000; index += 1) {
      buckets.set(`busy:${index}`, { active: 1, startedAt: [] })
    }

    expect(() =>
      (
        limiter as unknown as {
          bucketState: (bucketKey: string) => unknown
        }
      ).bucketState('overflow')
    ).toThrow(/bucket limit/i)
  })

  it('leaves active or queued buckets in place during cleanup', () => {
    const limiter = new FetchRateLimiter()
    const buckets = (limiter as unknown as { buckets: Map<string, { active: number; startedAt: number[] }> }).buckets
    const queuesByBucket = (limiter as unknown as { queuesByBucket: Map<string, Array<unknown>> }).queuesByBucket
    const active = { active: 1, startedAt: [] }
    const queued = { active: 0, startedAt: [] }

    buckets.set('active', active)
    buckets.set('queued', queued)
    queuesByBucket.set('queued', [{}])
    ;(
      limiter as unknown as {
        cleanupBucket: (
          bucketKey: string,
          bucket: { active: number; startedAt: number[] },
          intervalMs: number | undefined
        ) => void
      }
    ).cleanupBucket('active', active, 10)
    ;(
      limiter as unknown as {
        cleanupBucket: (
          bucketKey: string,
          bucket: { active: number; startedAt: number[] },
          intervalMs: number | undefined
        ) => void
      }
    ).cleanupBucket('queued', queued, 10)

    expect(buckets.has('active')).toBe(true)
    expect(buckets.has('queued')).toBe(true)
  })

  it('handles a queue that disappears between bucket selection and shifting', () => {
    const limiter = new FetchRateLimiter()
    const queuesByBucket = (limiter as unknown as { queuesByBucket: Map<string, Array<unknown>> }).queuesByBucket
    const pendingBuckets = (limiter as unknown as { pendingBuckets: Set<string> }).pendingBuckets
    const queue = [
      {
        bucketKey: 'vanishing',
        options: { maxConcurrent: 1, scope: 'global' },
        task: async () => 'unused',
        resolve: vi.fn(),
        reject: vi.fn()
      }
    ]
    queue.shift = vi.fn(() => undefined)
    queuesByBucket.set('vanishing', queue)
    pendingBuckets.add('vanishing')
    ;(limiter as unknown as { drain: () => void }).drain()

    expect(queuesByBucket.has('vanishing')).toBe(false)
    expect(pendingBuckets.has('vanishing')).toBe(false)
  })

  it('clears stale cleanup timers before running new work and rejects bucket access after disposal', async () => {
    vi.useFakeTimers()
    const limiter = new FetchRateLimiter()
    const timer = setTimeout(() => undefined, 1_000)
    const clearTimeoutSpy = vi.spyOn(global, 'clearTimeout')
    ;(
      limiter as unknown as {
        buckets: Map<string, { active: number; startedAt: number[]; cleanupTimer?: ReturnType<typeof setTimeout> }>
      }
    ).buckets.set('global', { active: 0, startedAt: [], cleanupTimer: timer })

    try {
      await expect(
        limiter.schedule({ maxConcurrent: 1 }, { key: 'a', fetcher: async () => 'a' }, async () => 'ok')
      ).resolves.toBe('ok')
      expect(clearTimeoutSpy).toHaveBeenCalledWith(timer)

      limiter.dispose()
      expect(() =>
        (
          limiter as unknown as {
            bucketState: (bucketKey: string) => unknown
          }
        ).bucketState('after-dispose')
      ).toThrow(/disposed/i)
    } finally {
      clearTimeoutSpy.mockRestore()
      vi.useRealTimers()
    }
  })

  it('keeps interval buckets when cleanup fires but new queued work exists', async () => {
    vi.useFakeTimers()
    const limiter = new FetchRateLimiter()
    const bucket = {
      active: 0,
      startedAt: [Date.now()],
      cleanupTimer: undefined as ReturnType<typeof setTimeout> | undefined
    }
    const buckets = (
      limiter as unknown as {
        buckets: Map<string, typeof bucket>
        queuesByBucket: Map<string, Array<unknown>>
      }
    ).buckets
    const queuesByBucket = (
      limiter as unknown as {
        buckets: Map<string, typeof bucket>
        queuesByBucket: Map<string, Array<unknown>>
      }
    ).queuesByBucket
    buckets.set('interval', bucket)
    ;(
      limiter as unknown as {
        cleanupBucket: (bucketKey: string, bucket: typeof bucket, intervalMs: number | undefined) => void
      }
    ).cleanupBucket('interval', bucket, 10)
    queuesByBucket.set('interval', [{}])
    await vi.advanceTimersByTimeAsync(10)

    expect(buckets.has('interval')).toBe(true)
    vi.useRealTimers()
  })
})
