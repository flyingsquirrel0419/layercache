import { describe, expect, it, vi } from 'vitest'
import { MetricsCollector } from '../../src/internal/MetricsCollector'

describe('MetricsCollector', () => {
  it('tracks counters, latency, hit rates, and clones snapshots', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-08T00:00:00Z'))

    try {
      const collector = new MetricsCollector()

      expect(collector.hitRate()).toEqual({ overall: 0, byLayer: {} })

      collector.increment('hits')
      collector.increment('misses', 2)
      collector.increment('writeFailures', 3)
      collector.incrementLayer('hitsByLayer', 'memory')
      collector.incrementLayer('missesByLayer', 'redis')
      collector.recordLatency('memory', 10)
      collector.recordLatency('memory', 30)

      const snapshot = collector.snapshot
      expect(snapshot.hits).toBe(1)
      expect(snapshot.misses).toBe(2)
      expect(snapshot.writeFailures).toBe(3)
      expect(snapshot.hitsByLayer.memory).toBe(1)
      expect(snapshot.missesByLayer.redis).toBe(1)
      expect(snapshot.latencyByLayer.memory).toEqual({ avgMs: 20, maxMs: 30, count: 2 })

      snapshot.hitsByLayer.memory = 99
      snapshot.latencyByLayer.memory.avgMs = 0

      expect(collector.snapshot.hitsByLayer.memory).toBe(1)
      expect(collector.snapshot.latencyByLayer.memory.avgMs).toBe(20)
      expect(collector.hitRate()).toEqual({
        overall: 1 / 3,
        byLayer: { memory: 1, redis: 0 }
      })

      collector.reset()
      expect(collector.snapshot).toEqual(
        expect.objectContaining({
          hits: 0,
          misses: 0,
          writeFailures: 0
        })
      )
      expect(collector.snapshot.resetAt).toBe(Date.now())
    } finally {
      vi.useRealTimers()
    }
  })

  it('attaches captured metrics to thrown errors', async () => {
    const collector = new MetricsCollector()
    const error = new Error('operation failed')

    await expect(
      collector.capture(async () => {
        collector.increment('misses')
        collector.increment('fetches')
        collector.incrementLayer('missesByLayer', 'memory')
        collector.recordLatency('memory', 12)
        throw error
      })
    ).rejects.toBe(error)

    expect((error as { metrics?: unknown }).metrics).toEqual(
      expect.objectContaining({
        misses: 1,
        fetches: 1,
        missesByLayer: { memory: 1 },
        latencyByLayer: { memory: { avgMs: 12, maxMs: 12, count: 1 } }
      })
    )
  })
})
