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

  it('waits for interval capacity before draining queued work', async () => {
    vi.useFakeTimers()
    const limiter = new FetchRateLimiter()
    const order: string[] = []

    try {
      const first = limiter.schedule(
        { intervalMs: 100, maxPerInterval: 1, scope: 'global' },
        { key: 'user:1', fetcher: async () => 'a' },
        async () => {
          order.push('first')
          return 'a'
        }
      )
      const second = limiter.schedule(
        { intervalMs: 100, maxPerInterval: 1, scope: 'global' },
        { key: 'user:2', fetcher: async () => 'b' },
        async () => {
          order.push('second')
          return 'b'
        }
      )

      await expect(first).resolves.toBe('a')
      expect(order).toEqual(['first'])

      await vi.advanceTimersByTimeAsync(99)
      expect(order).toEqual(['first'])

      await vi.advanceTimersByTimeAsync(1)
      await expect(second).resolves.toBe('b')
      expect(order).toEqual(['first', 'second'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('continues draining after a queued task rejects', async () => {
    vi.useFakeTimers()
    const limiter = new FetchRateLimiter()
    const order: string[] = []
    let rejectFirst: ((error: Error) => void) | undefined

    try {
      const first = limiter.schedule(
        { maxConcurrent: 1, scope: 'global' },
        { key: 'user:1', fetcher: async () => 'a' },
        () =>
          new Promise<string>((_resolve, reject) => {
            order.push('first-start')
            rejectFirst = reject
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

      rejectFirst?.(new Error('first failed'))
      await expect(first).rejects.toThrow('first failed')

      await vi.advanceTimersByTimeAsync(1)
      await expect(second).resolves.toBe('b')
      expect(order).toEqual(['first-start', 'second-start'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('drops corrupted pending queue entries while draining', () => {
    const limiter = new FetchRateLimiter()
    const queuesByBucket = (limiter as unknown as { queuesByBucket: Map<string, Array<unknown>> }).queuesByBucket
    const pendingBuckets = (limiter as unknown as { pendingBuckets: Set<string> }).pendingBuckets

    const sparseQueue: Array<unknown> = []
    sparseQueue.length = 1
    queuesByBucket.set('sparse', sparseQueue)
    pendingBuckets.add('sparse')
    ;(limiter as unknown as { drain: () => void }).drain()

    expect(queuesByBucket.has('sparse')).toBe(false)
    expect(pendingBuckets.has('sparse')).toBe(false)
  })

  it('cleans empty pending buckets and ignores drains after disposal', () => {
    const limiter = new FetchRateLimiter()
    const internals = limiter as unknown as {
      drain: () => void
      pendingBuckets: Set<string>
      queuesByBucket: Map<string, Array<unknown>>
    }
    internals.pendingBuckets.add('empty')
    internals.queuesByBucket.set('empty', [])

    internals.drain()
    expect(internals.pendingBuckets.has('empty')).toBe(false)
    expect(internals.queuesByBucket.has('empty')).toBe(false)

    limiter.dispose()
    expect(() => internals.drain()).not.toThrow()
  })

  it('clears a scheduled drain timer before processing pending work', () => {
    vi.useFakeTimers()
    const limiter = new FetchRateLimiter()
    const internals = limiter as unknown as {
      drain: () => void
      drainTimer?: ReturnType<typeof setTimeout>
    }
    internals.drainTimer = setTimeout(() => undefined, 1_000)

    internals.drain()

    expect(internals.drainTimer).toBeUndefined()
    vi.useRealTimers()
  })

  it('drops buckets when a queued entry disappears before shifting', () => {
    const limiter = new FetchRateLimiter()
    const queuesByBucket = (limiter as unknown as { queuesByBucket: Map<string, Array<unknown>> }).queuesByBucket
    const pendingBuckets = (limiter as unknown as { pendingBuckets: Set<string> }).pendingBuckets
    const queue = [
      {
        bucketKey: 'global',
        options: { maxConcurrent: 1, scope: 'global' },
        run: async () => undefined,
        reject: () => undefined
      }
    ]
    queue.shift = () => undefined
    queuesByBucket.set('global', queue)
    pendingBuckets.add('global')
    ;(limiter as unknown as { drain: () => void }).drain()

    expect(queuesByBucket.has('global')).toBe(false)
    expect(pendingBuckets.has('global')).toBe(false)
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

  it('clears pending interval cleanup when queued work starts for the same bucket', async () => {
    vi.useFakeTimers()
    const limiter = new FetchRateLimiter()
    const clearTimeoutSpy = vi.spyOn(global, 'clearTimeout')
    let releaseFirst: (() => void) | undefined

    try {
      const first = limiter.schedule(
        { maxConcurrent: 1, intervalMs: 100, maxPerInterval: 2, scope: 'global' },
        { key: 'user:1', fetcher: async () => 'a' },
        () =>
          new Promise<string>((resolve) => {
            releaseFirst = () => resolve('a')
          })
      )
      const second = limiter.schedule(
        { maxConcurrent: 1, intervalMs: 100, maxPerInterval: 2, scope: 'global' },
        { key: 'user:2', fetcher: async () => 'b' },
        async () => 'b'
      )

      await vi.advanceTimersByTimeAsync(1)
      const bucket = (
        limiter as unknown as { buckets: Map<string, { cleanupTimer?: ReturnType<typeof setTimeout> }> }
      ).buckets.get('global')
      expect(bucket).toBeDefined()
      if (!bucket) {
        throw new Error('Expected global rate-limit bucket to exist')
      }
      bucket.cleanupTimer = setTimeout(() => undefined, 1_000)

      releaseFirst?.()
      await expect(first).resolves.toBe('a')

      await vi.advanceTimersByTimeAsync(1)
      await expect(second).resolves.toBe('b')
      expect(clearTimeoutSpy).toHaveBeenCalled()
    } finally {
      clearTimeoutSpy.mockRestore()
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

  it('throws when the bucket hard limit cannot evict active buckets', () => {
    const limiter = new FetchRateLimiter()
    const buckets = (limiter as unknown as { buckets: Map<string, { active: number; startedAt: number[] }> }).buckets

    for (let index = 0; index < 10_000; index += 1) {
      buckets.set(`key:${index}`, { active: 1, startedAt: [] })
    }

    expect(() =>
      (limiter as unknown as { bucketState: (bucketKey: string) => unknown }).bucketState('key:overflow')
    ).toThrow(/bucket limit/i)
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

  it('rejects by default when a bucket queue exceeds MAX_QUEUE_PER_BUCKET', async () => {
    const limiter = new FetchRateLimiter()
    const queuesByBucket = (limiter as unknown as { queuesByBucket: Map<string, Array<unknown>> }).queuesByBucket

    queuesByBucket.set(
      'key:user:1',
      Array.from({ length: 10_000 }, () => ({}))
    )

    expect(limiter.rateLimitBypasses).toBe(0)

    await expect(
      limiter.schedule(
        { maxConcurrent: 1, scope: 'key' },
        { key: 'user:1', fetcher: async () => 'x' },
        async () => 'rejected'
      )
    ).rejects.toThrow(/queue overflow/i)
    expect(limiter.rateLimitBypasses).toBe(0)
  })

  it('bypasses rate limiting on queue overflow when explicitly configured', async () => {
    const limiter = new FetchRateLimiter()
    const queuesByBucket = (limiter as unknown as { queuesByBucket: Map<string, Array<unknown>> }).queuesByBucket

    queuesByBucket.set(
      'key:user:1',
      Array.from({ length: 10_000 }, () => ({}))
    )

    const result = await limiter.schedule(
      { maxConcurrent: 1, scope: 'key', queueOverflow: 'bypass' },
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
      expect(() =>
        (limiter as unknown as { bucketState: (bucketKey: string) => unknown }).bucketState('key:disposed')
      ).toThrow(/disposed/i)
      await expect(
        limiter.schedule({ maxConcurrent: 1 }, { key: 'user:2', fetcher: async () => 'b' }, async () => 'b')
      ).rejects.toThrow(/disposed/i)
    } finally {
      vi.useRealTimers()
    }
  })
})
