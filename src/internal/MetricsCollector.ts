import { AsyncLocalStorage } from 'node:async_hooks'
import type { CacheHitRateSnapshot, CacheLayerLatency, CacheMetricsSnapshot } from '../types'

export class MetricsCollector {
  private readonly captures = new AsyncLocalStorage<CacheMetricsSnapshot[]>()
  private data: CacheMetricsSnapshot = this.empty()

  get snapshot(): CacheMetricsSnapshot {
    return {
      ...this.data,
      hitsByLayer: { ...this.data.hitsByLayer },
      missesByLayer: { ...this.data.missesByLayer },
      latencyByLayer: Object.fromEntries(Object.entries(this.data.latencyByLayer).map(([k, v]) => [k, { ...v }]))
    }
  }

  increment(
    field: keyof Omit<CacheMetricsSnapshot, 'hitsByLayer' | 'missesByLayer' | 'latencyByLayer' | 'resetAt'>,
    amount = 1
  ): void {
    ;(this.data[field] as number) += amount
    for (const capture of this.captures.getStore() ?? []) {
      ;(capture[field] as number) += amount
    }
  }

  incrementLayer(map: 'hitsByLayer' | 'missesByLayer', layerName: string): void {
    this.data[map][layerName] = (this.data[map][layerName] ?? 0) + 1
    for (const capture of this.captures.getStore() ?? []) {
      capture[map][layerName] = (capture[map][layerName] ?? 0) + 1
    }
  }

  /**
   * Records a read latency sample for the given layer.
   * Maintains a rolling average and max using Welford's online algorithm.
   */
  recordLatency(layerName: string, durationMs: number): void {
    this.recordLatencySample(this.data, layerName, durationMs)
    for (const capture of this.captures.getStore() ?? []) {
      this.recordLatencySample(capture, layerName, durationMs)
    }
  }

  async capture<T>(operation: () => Promise<T>): Promise<{ result: T; metrics: CacheMetricsSnapshot }> {
    const metrics = this.empty()
    const activeCaptures = this.captures.getStore()
    const captures = activeCaptures ? [...activeCaptures, metrics] : [metrics]
    try {
      const result = await this.captures.run(captures, operation)
      return { result, metrics }
    } catch (error) {
      if ((typeof error === 'object' || typeof error === 'function') && error !== null) {
        ;(error as { metrics?: CacheMetricsSnapshot }).metrics = metrics
      }
      throw error
    }
  }

  private recordLatencySample(metrics: CacheMetricsSnapshot, layerName: string, durationMs: number): void {
    const existing = metrics.latencyByLayer[layerName]
    if (!existing) {
      metrics.latencyByLayer[layerName] = { avgMs: durationMs, maxMs: durationMs, count: 1 }
      return
    }

    existing.count += 1
    // Welford's online mean update: avg_n = avg_{n-1} + (x - avg_{n-1}) / n
    existing.avgMs += (durationMs - existing.avgMs) / existing.count
    if (durationMs > existing.maxMs) {
      existing.maxMs = durationMs
    }
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
      latencyByLayer: {},
      resetAt: Date.now()
    }
  }
}
