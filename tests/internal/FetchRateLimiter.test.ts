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

  it('respects maxConcurrent limits and drains queued work later', async () => {
    vi.useFakeTimers()
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
    await expect(second).resolves.toBe('b')
    expect(order).toEqual(['first-start', 'second-start'])
    vi.useRealTimers()
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
})
