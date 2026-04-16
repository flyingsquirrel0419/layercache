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

  it('rejects new keys when maxInFlight is exceeded', async () => {
    const guard = new StampedeGuard({ maxInFlight: 2 })
    let resolve1!: () => void
    let resolve2!: () => void
    const p1 = new Promise<void>((resolve) => {
      resolve1 = resolve
    })
    const p2 = new Promise<void>((resolve) => {
      resolve2 = resolve
    })

    const t1 = guard.execute('k1', async () => {
      await p1
      return 'a'
    })
    const t2 = guard.execute('k2', async () => {
      await p2
      return 'b'
    })

    await expect(guard.execute('k3', async () => 'c')).rejects.toThrow(/in-flight limit/)

    resolve1()
    resolve2()
    await Promise.all([t1, t2])
  })

  it('rejects with a timeout when entryTimeoutMs elapses', async () => {
    const guard = new StampedeGuard({ entryTimeoutMs: 20 })

    await expect(
      guard.execute('slow-key', async () => {
        await new Promise((resolve) => setTimeout(resolve, 200))
        return 'late'
      })
    ).rejects.toThrow(/timed out/)
  })

  it('releases the entry after a timeout so subsequent calls can retry', async () => {
    const guard = new StampedeGuard({ entryTimeoutMs: 30 })

    await expect(
      guard.execute('retry-key', async () => {
        await new Promise((resolve) => setTimeout(resolve, 200))
      })
    ).rejects.toThrow(/timed out/)

    const result = await guard.execute('retry-key', async () => 'success')
    expect(result).toBe('success')
  })

  it('truncates keys in timeout error messages', async () => {
    const guard = new StampedeGuard({ entryTimeoutMs: 10 })
    const longKey = 'x'.repeat(200)

    try {
      await guard.execute(longKey, async () => {
        await new Promise((resolve) => setTimeout(resolve, 200))
      })
      expect.unreachable('should have thrown')
    } catch (error) {
      const message = (error as Error).message
      expect(message).toContain('timed out')
      expect(message.length).toBeLessThan(200)
      expect(message).toContain('...')
    }
  })
})
