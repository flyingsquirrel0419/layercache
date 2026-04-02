import { describe, expect, it } from 'vitest'
import { CacheBridge } from '../../src/CacheBridge'
import { MemoryLayer } from '../../src/layers/MemoryLayer'

describe('Stampede prevention', () => {
  it('runs the fetcher once for concurrent requests', async () => {
    const cache = new CacheBridge([new MemoryLayer({ ttl: 60 })])
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
})
