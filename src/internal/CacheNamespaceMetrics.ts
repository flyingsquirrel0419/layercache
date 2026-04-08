import type { CacheHitRateSnapshot, CacheMetricsSnapshot } from '../types'

export function createEmptyNamespaceMetrics(resetAt = Date.now()): CacheMetricsSnapshot {
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
    resetAt
  }
}

export function cloneNamespaceMetrics(metrics: CacheMetricsSnapshot): CacheMetricsSnapshot {
  return {
    ...metrics,
    hitsByLayer: { ...metrics.hitsByLayer },
    missesByLayer: { ...metrics.missesByLayer },
    latencyByLayer: Object.fromEntries(
      Object.entries(metrics.latencyByLayer).map(([key, value]) => [key, { ...value }])
    )
  }
}

export function diffNamespaceMetrics(before: CacheMetricsSnapshot, after: CacheMetricsSnapshot): CacheMetricsSnapshot {
  const latencyByLayer = Object.fromEntries(
    Object.entries(after.latencyByLayer).map(([layer, value]) => [
      layer,
      {
        avgMs: value.avgMs,
        maxMs: value.maxMs,
        count: Math.max(0, value.count - (before.latencyByLayer[layer]?.count ?? 0))
      }
    ])
  )

  return {
    hits: after.hits - before.hits,
    misses: after.misses - before.misses,
    fetches: after.fetches - before.fetches,
    sets: after.sets - before.sets,
    deletes: after.deletes - before.deletes,
    backfills: after.backfills - before.backfills,
    invalidations: after.invalidations - before.invalidations,
    staleHits: after.staleHits - before.staleHits,
    refreshes: after.refreshes - before.refreshes,
    refreshErrors: after.refreshErrors - before.refreshErrors,
    writeFailures: after.writeFailures - before.writeFailures,
    singleFlightWaits: after.singleFlightWaits - before.singleFlightWaits,
    negativeCacheHits: after.negativeCacheHits - before.negativeCacheHits,
    circuitBreakerTrips: after.circuitBreakerTrips - before.circuitBreakerTrips,
    degradedOperations: after.degradedOperations - before.degradedOperations,
    hitsByLayer: diffMetricMap(before.hitsByLayer, after.hitsByLayer),
    missesByLayer: diffMetricMap(before.missesByLayer, after.missesByLayer),
    latencyByLayer,
    resetAt: after.resetAt
  }
}

export function addNamespaceMetrics(base: CacheMetricsSnapshot, delta: CacheMetricsSnapshot): CacheMetricsSnapshot {
  return {
    hits: base.hits + delta.hits,
    misses: base.misses + delta.misses,
    fetches: base.fetches + delta.fetches,
    sets: base.sets + delta.sets,
    deletes: base.deletes + delta.deletes,
    backfills: base.backfills + delta.backfills,
    invalidations: base.invalidations + delta.invalidations,
    staleHits: base.staleHits + delta.staleHits,
    refreshes: base.refreshes + delta.refreshes,
    refreshErrors: base.refreshErrors + delta.refreshErrors,
    writeFailures: base.writeFailures + delta.writeFailures,
    singleFlightWaits: base.singleFlightWaits + delta.singleFlightWaits,
    negativeCacheHits: base.negativeCacheHits + delta.negativeCacheHits,
    circuitBreakerTrips: base.circuitBreakerTrips + delta.circuitBreakerTrips,
    degradedOperations: base.degradedOperations + delta.degradedOperations,
    hitsByLayer: addMetricMap(base.hitsByLayer, delta.hitsByLayer),
    missesByLayer: addMetricMap(base.missesByLayer, delta.missesByLayer),
    latencyByLayer: cloneNamespaceMetrics(delta).latencyByLayer,
    resetAt: base.resetAt
  }
}

export function computeNamespaceHitRate(metrics: CacheMetricsSnapshot): CacheHitRateSnapshot {
  const total = metrics.hits + metrics.misses
  const overall = total === 0 ? 0 : metrics.hits / total
  const byLayer: Record<string, number> = {}
  const layers = new Set([...Object.keys(metrics.hitsByLayer), ...Object.keys(metrics.missesByLayer)])

  for (const layer of layers) {
    const hits = metrics.hitsByLayer[layer] ?? 0
    const misses = metrics.missesByLayer[layer] ?? 0
    byLayer[layer] = hits + misses === 0 ? 0 : hits / (hits + misses)
  }

  return { overall, byLayer }
}

function diffMetricMap(before: Record<string, number>, after: Record<string, number>): Record<string, number> {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)])
  const result: Record<string, number> = {}

  for (const key of keys) {
    result[key] = (after[key] ?? 0) - (before[key] ?? 0)
  }

  return result
}

function addMetricMap(base: Record<string, number>, delta: Record<string, number>): Record<string, number> {
  const keys = new Set([...Object.keys(base), ...Object.keys(delta)])
  const result: Record<string, number> = {}

  for (const key of keys) {
    result[key] = (base[key] ?? 0) + (delta[key] ?? 0)
  }

  return result
}
