import { describe, expect, it } from 'vitest'
import { FetchRateLimiter } from '../../src/internal/FetchRateLimiter'

describe('FetchRateLimiter', () => {
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
    const limiter = new FetchRateLimiter()

    await limiter.schedule(
      { intervalMs: 10, maxPerInterval: 1, scope: 'key' },
      { key: 'user:1', fetcher: async () => 'a' },
      async () => 'a'
    )

    await new Promise((resolve) => setTimeout(resolve, 20))

    const buckets = (limiter as unknown as { buckets: Map<string, unknown> }).buckets
    expect(buckets.size).toBe(0)
  })
})
