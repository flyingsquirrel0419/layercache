import type { CacheStack } from '../CacheStack'

/**
 * Returns a function that generates a Prometheus-compatible text exposition
 * of the cache metrics from one or more CacheStack instances.
 *
 * Now includes per-layer latency gauges (`layercache_layer_latency_avg_ms`,
 * `layercache_layer_latency_max_ms`, `layercache_layer_latency_count`).
 *
 * Usage example:
 * ```ts
 * const collect = createPrometheusMetricsExporter(cache)
 * http.createServer(async (_req, res) => {
 *   res.setHeader('content-type', 'text/plain; version=0.0.4; charset=utf-8')
 *   res.end(collect())
 * }).listen(9091)
 * ```
 *
 * @param stacks  One or more CacheStack instances. When multiple stacks are
 *                given, each must be named via the optional `name` parameter.
 */
export function createPrometheusMetricsExporter(
  stacks: CacheStack | Array<{ stack: CacheStack; name: string }>
): () => string {
  return () => {
    const entries = Array.isArray(stacks) ? stacks : [{ stack: stacks, name: 'default' }]

    const lines: string[] = []

    lines.push('# HELP layercache_hits_total Total number of cache hits')
    lines.push('# TYPE layercache_hits_total counter')
    lines.push('# HELP layercache_misses_total Total number of cache misses')
    lines.push('# TYPE layercache_misses_total counter')
    lines.push('# HELP layercache_fetches_total Total fetcher invocations (full misses)')
    lines.push('# TYPE layercache_fetches_total counter')
    lines.push('# HELP layercache_sets_total Total number of cache sets')
    lines.push('# TYPE layercache_sets_total counter')
    lines.push('# HELP layercache_deletes_total Total number of cache deletes')
    lines.push('# TYPE layercache_deletes_total counter')
    lines.push('# HELP layercache_backfills_total Total number of backfill operations')
    lines.push('# TYPE layercache_backfills_total counter')
    lines.push('# HELP layercache_stale_hits_total Total number of stale hits served')
    lines.push('# TYPE layercache_stale_hits_total counter')
    lines.push('# HELP layercache_refreshes_total Background refreshes triggered')
    lines.push('# TYPE layercache_refreshes_total counter')
    lines.push('# HELP layercache_refresh_errors_total Background refresh errors')
    lines.push('# TYPE layercache_refresh_errors_total counter')
    lines.push('# HELP layercache_negative_cache_hits_total Negative cache hits')
    lines.push('# TYPE layercache_negative_cache_hits_total counter')
    lines.push('# HELP layercache_circuit_breaker_trips_total Circuit breaker trips')
    lines.push('# TYPE layercache_circuit_breaker_trips_total counter')
    lines.push('# HELP layercache_degraded_operations_total Operations run in degraded mode')
    lines.push('# TYPE layercache_degraded_operations_total counter')
    lines.push('# HELP layercache_hit_rate Overall cache hit rate (0-1)')
    lines.push('# TYPE layercache_hit_rate gauge')
    lines.push('# HELP layercache_hits_by_layer_total Hits broken down by layer')
    lines.push('# TYPE layercache_hits_by_layer_total counter')
    lines.push('# HELP layercache_misses_by_layer_total Misses broken down by layer')
    lines.push('# TYPE layercache_misses_by_layer_total counter')
    lines.push('# HELP layercache_layer_latency_avg_ms Average read latency per layer in milliseconds')
    lines.push('# TYPE layercache_layer_latency_avg_ms gauge')
    lines.push('# HELP layercache_layer_latency_max_ms Maximum read latency per layer in milliseconds')
    lines.push('# TYPE layercache_layer_latency_max_ms gauge')
    lines.push('# HELP layercache_layer_latency_count Number of read latency samples per layer')
    lines.push('# TYPE layercache_layer_latency_count counter')

    for (const { stack, name } of entries) {
      const m = stack.getMetrics()
      const hr = stack.getHitRate()
      const label = `cache="${sanitizeLabel(name)}"`

      lines.push(`layercache_hits_total{${label}} ${m.hits}`)
      lines.push(`layercache_misses_total{${label}} ${m.misses}`)
      lines.push(`layercache_fetches_total{${label}} ${m.fetches}`)
      lines.push(`layercache_sets_total{${label}} ${m.sets}`)
      lines.push(`layercache_deletes_total{${label}} ${m.deletes}`)
      lines.push(`layercache_backfills_total{${label}} ${m.backfills}`)
      lines.push(`layercache_stale_hits_total{${label}} ${m.staleHits}`)
      lines.push(`layercache_refreshes_total{${label}} ${m.refreshes}`)
      lines.push(`layercache_refresh_errors_total{${label}} ${m.refreshErrors}`)
      lines.push(`layercache_negative_cache_hits_total{${label}} ${m.negativeCacheHits}`)
      lines.push(`layercache_circuit_breaker_trips_total{${label}} ${m.circuitBreakerTrips}`)
      lines.push(`layercache_degraded_operations_total{${label}} ${m.degradedOperations}`)
      lines.push(`layercache_hit_rate{${label}} ${hr.overall.toFixed(6)}`)

      for (const [layerName, count] of Object.entries(m.hitsByLayer)) {
        lines.push(`layercache_hits_by_layer_total{${label},layer="${sanitizeLabel(layerName)}"} ${count}`)
      }
      for (const [layerName, count] of Object.entries(m.missesByLayer)) {
        lines.push(`layercache_misses_by_layer_total{${label},layer="${sanitizeLabel(layerName)}"} ${count}`)
      }
      for (const [layerName, latency] of Object.entries(m.latencyByLayer)) {
        const layerLabel = `${label},layer="${sanitizeLabel(layerName)}"`
        lines.push(`layercache_layer_latency_avg_ms{${layerLabel}} ${latency.avgMs.toFixed(4)}`)
        lines.push(`layercache_layer_latency_max_ms{${layerLabel}} ${latency.maxMs.toFixed(4)}`)
        lines.push(`layercache_layer_latency_count{${layerLabel}} ${latency.count}`)
      }
    }

    lines.push('') // trailing newline
    return lines.join('\n')
  }
}

function sanitizeLabel(value: string): string {
  // Prometheus label values must not contain double quotes, backslashes, or newlines/carriage returns
  return value.replace(/["\\\n\r]/g, '_')
}
