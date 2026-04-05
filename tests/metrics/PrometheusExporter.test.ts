import { describe, expect, it } from 'vitest'
import { CacheStack } from '../../src/CacheStack'
import { MemoryLayer } from '../../src/layers/MemoryLayer'
import { createPrometheusMetricsExporter } from '../../src/metrics/PrometheusExporter'

describe('PrometheusExporter', () => {
  it('should export valid prometheus text format for a single stack', async () => {
    const cache = new CacheStack([new MemoryLayer({ ttl: 60 })])
    const collect = createPrometheusMetricsExporter(cache)

    // Generate some metrics
    await cache.set('key1', 'value1')
    await cache.get('key1')
    await cache.get('missing')

    const output = collect()

    // Check TYPE and HELP lines exist
    expect(output).toContain('# HELP layercache_hits_total')
    expect(output).toContain('# TYPE layercache_hits_total counter')
    expect(output).toContain('# HELP layercache_misses_total')
    expect(output).toContain('# TYPE layercache_hit_rate gauge')

    // Check counter lines contain correct label
    expect(output).toContain('layercache_hits_total{cache="default"}')
    expect(output).toContain('layercache_misses_total{cache="default"}')
    expect(output).toContain('layercache_sets_total{cache="default"}')
    expect(output).toContain('layercache_hit_rate{cache="default"}')

    // Check per-layer metrics exist
    expect(output).toContain('layercache_hits_by_layer_total{cache="default",layer="memory"}')

    // Should end with a newline
    expect(output.endsWith('\n')).toBe(true)

    await cache.disconnect()
  })

  it('should export metrics for multiple named stacks', async () => {
    const cache1 = new CacheStack([new MemoryLayer({ ttl: 10 })])
    const cache2 = new CacheStack([new MemoryLayer({ ttl: 10, name: 'fast' })])

    const collect = createPrometheusMetricsExporter([
      { stack: cache1, name: 'primary' },
      { stack: cache2, name: 'secondary' }
    ])

    await cache1.set('a', 1)
    await cache2.set('b', 2)

    const output = collect()

    expect(output).toContain('cache="primary"')
    expect(output).toContain('cache="secondary"')

    await cache1.disconnect()
    await cache2.disconnect()
  })

  it('should export latency metrics', async () => {
    const cache = new CacheStack([new MemoryLayer({ ttl: 60 })])
    const collect = createPrometheusMetricsExporter(cache)

    await cache.set('key1', 'val')
    await cache.get('key1')

    const output = collect()

    expect(output).toContain('# HELP layercache_layer_latency_avg_ms')
    expect(output).toContain('# TYPE layercache_layer_latency_avg_ms gauge')
    expect(output).toContain('layercache_layer_latency_avg_ms{cache="default",layer="memory"}')
    expect(output).toContain('layercache_layer_latency_max_ms{cache="default",layer="memory"}')
    expect(output).toContain('layercache_layer_latency_count{cache="default",layer="memory"}')

    await cache.disconnect()
  })

  it('should sanitize label values', async () => {
    const cache = new CacheStack([new MemoryLayer({ ttl: 10, name: 'layer"evil\\name\n' })])
    const collect = createPrometheusMetricsExporter([{ stack: cache, name: 'test"cache' }])

    await cache.get('k')

    const output = collect()

    // Double quotes, backslashes and newlines should be replaced with underscores
    expect(output).not.toContain('"evil')
    expect(output).toContain('test_cache')

    await cache.disconnect()
  })

  it('should export zero hit rate when no operations have occurred', () => {
    const cache = new CacheStack([new MemoryLayer({ ttl: 10 })])
    const collect = createPrometheusMetricsExporter(cache)
    const output = collect()

    expect(output).toContain('layercache_hit_rate{cache="default"} 0.000000')
  })
})
