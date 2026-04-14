import { describe, expect, it } from 'vitest'
import { CacheStack } from '../../src/CacheStack'
import { MemoryLayer } from '../../src/layers/MemoryLayer'
import { StampedeGuard } from '../../src/stampede/StampedeGuard'

describe('Stampede prevention', () => {
  it('runs the fetcher once for concurrent requests', async () => {
    const cache = new CacheStack([new MemoryLayer({ ttl: 60 })])
    let executions = 0

    const results = await Promise.all(
      Array.from({ length: 50 }, () =>
        cache.get('user:1', async () => {
          executions += 1
          await new Promise((resolve) => setTimeout(resolve, 10))
          return { id: 1 }
        })
      )
    )

    expect(executions).toBe(1)
    expect(results.every((value) => value?.id === 1)).toBe(true)
  })

  it('releases mutex entries after concurrent work completes', async () => {
    const guard = new StampedeGuard()

    await Promise.all(
      Array.from({ length: 25 }, () =>
        guard.execute('shared-key', async () => {
          await new Promise((resolve) => setTimeout(resolve, 5))
        })
      )
    )

    expect((guard as unknown as { inFlight: Map<string, unknown> }).inFlight.size).toBe(0)
  })

  it('shares the same in-flight promise for concurrent callers', async () => {
    const guard = new StampedeGuard()
    let executions = 0

    const [first, second, third] = await Promise.all([
      guard.execute('shared-key', async () => {
        executions += 1
        await new Promise((resolve) => setTimeout(resolve, 5))
        return 'value'
      }),
      guard.execute('shared-key', async () => {
        executions += 1
        return 'duplicate'
      }),
      guard.execute('shared-key', async () => {
        executions += 1
        return 'duplicate'
      })
    ])

    expect(first).toBe('value')
    expect(second).toBe('value')
    expect(third).toBe('value')
    expect(executions).toBe(1)
  })
})
