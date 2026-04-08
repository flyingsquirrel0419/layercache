import { describe, expect, it } from 'vitest'
import {
  addNamespaceMetrics,
  cloneNamespaceMetrics,
  computeNamespaceHitRate,
  createEmptyNamespaceMetrics,
  diffNamespaceMetrics
} from '../../src/internal/CacheNamespaceMetrics'
import type { CacheMetricsSnapshot } from '../../src/types'

describe('CacheNamespaceMetrics', () => {
  it('creates isolated empty metric snapshots', () => {
    const first = createEmptyNamespaceMetrics(100)
    const second = createEmptyNamespaceMetrics(200)

    expect(first.resetAt).toBe(100)
    expect(second.resetAt).toBe(200)
    expect(first.hitsByLayer).not.toBe(second.hitsByLayer)
    expect(first.missesByLayer).not.toBe(second.missesByLayer)
    expect(first.latencyByLayer).not.toBe(second.latencyByLayer)
  })

  it('clones namespace metrics without retaining nested references', () => {
    const metrics: CacheMetricsSnapshot = {
      ...createEmptyNamespaceMetrics(123),
      hits: 1,
      hitsByLayer: { memory: 1 },
      latencyByLayer: {
        memory: { avgMs: 2, maxMs: 5, count: 1 }
      }
    }

    const cloned = cloneNamespaceMetrics(metrics)
    cloned.hitsByLayer.memory = 99
    cloned.latencyByLayer.memory.count = 99

    expect(metrics.hitsByLayer.memory).toBe(1)
    expect(metrics.latencyByLayer.memory.count).toBe(1)
  })

  it('diffs and adds namespace metrics across disjoint layer maps', () => {
    const before: CacheMetricsSnapshot = {
      ...createEmptyNamespaceMetrics(10),
      hits: 1,
      hitsByLayer: { memory: 1, stale: 4 },
      missesByLayer: { redis: 1, stale: 2 },
      latencyByLayer: {
        memory: { avgMs: 3, maxMs: 4, count: 2 }
      }
    }
    const after: CacheMetricsSnapshot = {
      ...createEmptyNamespaceMetrics(20),
      hits: 3,
      misses: 2,
      hitsByLayer: { memory: 2, redis: 1 },
      missesByLayer: { redis: 1, disk: 2 },
      latencyByLayer: {
        memory: { avgMs: 4, maxMs: 7, count: 5 },
        redis: { avgMs: 6, maxMs: 8, count: 1 }
      }
    }

    const delta = diffNamespaceMetrics(before, after)
    expect(delta.hits).toBe(2)
    expect(delta.misses).toBe(2)
    expect(delta.hitsByLayer).toEqual({ memory: 1, stale: -4, redis: 1 })
    expect(delta.missesByLayer).toEqual({ redis: 0, stale: -2, disk: 2 })
    expect(delta.latencyByLayer).toEqual({
      memory: { avgMs: 4, maxMs: 7, count: 3 },
      redis: { avgMs: 6, maxMs: 8, count: 1 }
    })

    const combined = addNamespaceMetrics(before, delta)
    expect(combined.hits).toBe(3)
    expect(combined.misses).toBe(2)
    expect(combined.hitsByLayer).toEqual({ memory: 2, stale: 0, redis: 1 })
    expect(combined.missesByLayer).toEqual({ redis: 1, stale: 0, disk: 2 })

    const sparseCombined = addNamespaceMetrics(
      {
        ...createEmptyNamespaceMetrics(30),
        hitsByLayer: { memory: 2 },
        missesByLayer: { redis: 1 }
      },
      createEmptyNamespaceMetrics(31)
    )
    expect(sparseCombined.hitsByLayer).toEqual({ memory: 2 })
    expect(sparseCombined.missesByLayer).toEqual({ redis: 1 })
  })

  it('computes namespace hit rates from merged layer stats', () => {
    expect(computeNamespaceHitRate(createEmptyNamespaceMetrics(1))).toEqual({
      overall: 0,
      byLayer: {}
    })

    const metrics: CacheMetricsSnapshot = {
      ...createEmptyNamespaceMetrics(2),
      hits: 3,
      misses: 1,
      hitsByLayer: { memory: 3, hitsOnly: 1, empty: 0 },
      missesByLayer: { memory: 1, missesOnly: 2, empty: 0 }
    }

    expect(computeNamespaceHitRate(metrics)).toEqual({
      overall: 0.75,
      byLayer: {
        memory: 0.75,
        hitsOnly: 1,
        missesOnly: 0,
        empty: 0
      }
    })
  })
})
