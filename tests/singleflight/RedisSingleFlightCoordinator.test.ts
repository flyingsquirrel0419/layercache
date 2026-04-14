import type Redis from 'ioredis'
import { describe, expect, it, vi } from 'vitest'
import { RedisSingleFlightCoordinator } from '../../src/singleflight/RedisSingleFlightCoordinator'

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

describe('RedisSingleFlightCoordinator', () => {
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
})
