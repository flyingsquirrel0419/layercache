import type { CacheHitRateSnapshot, CacheMetricsSnapshot } from '../types'

export class MetricsCollector {
  private data: CacheMetricsSnapshot = this.empty()

  get snapshot(): CacheMetricsSnapshot {
    return { ...this.data }
  }

  increment(field: keyof Omit<CacheMetricsSnapshot, 'hitsByLayer' | 'missesByLayer' | 'resetAt'>, amount = 1): void {
    ;(this.data[field] as number) += amount
  }

  incrementLayer(map: 'hitsByLayer' | 'missesByLayer', layerName: string): void {
    this.data[map][layerName] = (this.data[map][layerName] ?? 0) + 1
  }

  reset(): void {
    this.data = this.empty()
  }

  hitRate(): CacheHitRateSnapshot {
    const total = this.data.hits + this.data.misses
    const overall = total === 0 ? 0 : this.data.hits / total

    const byLayer: Record<string, number> = {}
    const allLayers = new Set([...Object.keys(this.data.hitsByLayer), ...Object.keys(this.data.missesByLayer)])
    for (const layer of allLayers) {
      const h = this.data.hitsByLayer[layer] ?? 0
      const m = this.data.missesByLayer[layer] ?? 0
      byLayer[layer] = h + m === 0 ? 0 : h / (h + m)
    }

    return { overall, byLayer }
  }

  private empty(): CacheMetricsSnapshot {
    return {
      hits: 0,
      misses: 0,
      fetches: 0,
      sets: 0,
      deletes: 0,
      backfills: 0,
      invalidations: 0,
      staleHits: 0,
      refreshes: 0,
      refreshErrors: 0,
      writeFailures: 0,
      singleFlightWaits: 0,
      negativeCacheHits: 0,
      circuitBreakerTrips: 0,
      degradedOperations: 0,
      hitsByLayer: {},
      missesByLayer: {},
      resetAt: Date.now()
    }
  }
}
