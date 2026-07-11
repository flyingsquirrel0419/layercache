import { describe, expect, it } from 'vitest'
import { RedisSingleFlightCoordinator } from '../../../src/singleflight/RedisSingleFlightCoordinator'
import { createTestRedis } from '../../helpers/test-redis'

describe('RedisSingleFlightCoordinator (real Redis)', () => {
  it('executes the worker only once for concurrent calls on the same key', async () => {
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
          await new Promise((resolve) => {
            setTimeout(resolve, 100)
          })
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

  it('allows independent execution for different keys', async () => {
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

  it('allows retry after lease expiration', async () => {
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
        await new Promise((resolve) => {
          setTimeout(resolve, 50)
        })
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
