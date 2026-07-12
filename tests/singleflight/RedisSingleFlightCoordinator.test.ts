import type Redis from 'ioredis'
import { describe, expect, it, vi } from 'vitest'
import { RedisSingleFlightCoordinator } from '../../src/singleflight/RedisSingleFlightCoordinator'
import { createTestRedis, realRedisTest } from '../helpers/test-redis'

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

describe('RedisSingleFlightCoordinator', () => {
  it('rejects invalid commandTimeoutMs values', () => {
    const client = {
      set: vi.fn(),
      eval: vi.fn()
    } as unknown as Redis

    expect(() => new RedisSingleFlightCoordinator({ client, commandTimeoutMs: 0 })).toThrow(/positive number/i)
    expect(() => new RedisSingleFlightCoordinator({ client, commandTimeoutMs: Number.NaN })).toThrow(/positive number/i)
  })

  it('times out slow lock acquisition when commandTimeoutMs is configured', async () => {
    const client = {
      set: vi.fn(async () => {
        await sleep(40)
        return 'OK'
      }),
      eval: vi.fn(async () => 1)
    } as unknown as Redis
    const coordinator = new RedisSingleFlightCoordinator({
      client,
      commandTimeoutMs: 10
    })

    await expect(
      coordinator.execute(
        'user:1',
        { leaseMs: 1_000, waitTimeoutMs: 100, pollIntervalMs: 10 },
        async () => 'worker',
        async () => 'waiter'
      )
    ).rejects.toThrow(/timed out after 10ms/i)
  })

  realRedisTest.it('executes the worker only once for concurrent calls on the same key', async () => {
    const client = createTestRedis()
    const coordinator = new RedisSingleFlightCoordinator({ client, prefix: 'sf:' })
    let workerCalls = 0

    const options = { leaseMs: 5_000, waitTimeoutMs: 10_000, pollIntervalMs: 50 }

    const results = await Promise.all([
      coordinator.execute(
        'dedup:key1',
        options,
        async () => {
          workerCalls++
          await sleep(100)
          return 'worker'
        },
        async () => 'waiter'
      ),
      coordinator.execute(
        'dedup:key1',
        options,
        async () => {
          workerCalls++
          return 'worker-late'
        },
        async () => 'waiter'
      )
    ])

    expect(workerCalls).toBe(1)
    expect(results).toContain('worker')
    expect(results).toContain('waiter')
  })

  realRedisTest.it('allows independent execution for different keys', async () => {
    const client = createTestRedis()
    const coordinator = new RedisSingleFlightCoordinator({ client, prefix: 'sf:' })
    let aCalls = 0
    let bCalls = 0

    const options = { leaseMs: 5_000, waitTimeoutMs: 10_000, pollIntervalMs: 50 }

    const [resultA, resultB] = await Promise.all([
      coordinator.execute(
        'independent:a',
        options,
        async () => {
          aCalls++
          return 'a'
        },
        async () => 'waiter-a'
      ),
      coordinator.execute(
        'independent:b',
        options,
        async () => {
          bCalls++
          return 'b'
        },
        async () => 'waiter-b'
      )
    ])

    expect(aCalls).toBe(1)
    expect(bCalls).toBe(1)
    expect(resultA).toBe('a')
    expect(resultB).toBe('b')
  })

  realRedisTest.it('allows retry after lease expiration', async () => {
    const client = createTestRedis()
    const coordinator = new RedisSingleFlightCoordinator({ client, prefix: 'sf:' })
    let firstCall = false
    let secondCall = false

    const shortLease = { leaseMs: 200, waitTimeoutMs: 5_000, pollIntervalMs: 50 }

    await coordinator.execute(
      'lease:expire',
      shortLease,
      async () => {
        firstCall = true
        await sleep(50)
        return 'first'
      },
      async () => 'waiter'
    )

    await coordinator.execute(
      'lease:expire',
      shortLease,
      async () => {
        secondCall = true
        return 'second'
      },
      async () => 'waiter'
    )

    expect(firstCall).toBe(true)
    expect(secondCall).toBe(true)
  })
})
