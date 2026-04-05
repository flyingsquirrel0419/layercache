# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **`has(key)`** method on `CacheStack`, `CacheNamespace`, `MemoryLayer`, and `RedisLayer` — check key existence without deserializing the value.
- **`ttl(key)`** method on `CacheStack`, `CacheNamespace`, `MemoryLayer`, and `RedisLayer` — query remaining TTL in seconds.
- **`mdelete(keys)`** bulk-delete method on `CacheStack` and `CacheNamespace`.
- **`getOrSet(key, fetcher, options)`** explicit alias for `get()` on `CacheStack` and `CacheNamespace`.
- **`getHitRate()`** method on `CacheStack` and `CacheNamespace` returning `CacheHitRateSnapshot` (overall and per-layer hit rates).
- **`size()`** optional method on `CacheLayer` interface, implemented on `MemoryLayer`, `RedisLayer`, and `DiskLayer`.
- **`CacheWarmOptions.onProgress`** callback for tracking warm-up progress (`CacheWarmProgress`).
- **`DiskLayer`** — new file-system backed cache layer for persistence across process restarts without Redis.
- **`MemcachedLayer`** — new adapter that wraps any Memcached client implementing `MemcachedClient`.
- **`createPrometheusMetricsExporter`** — generates Prometheus text-format metrics from one or more `CacheStack` instances.
- **`CacheStackEvents`** typed interface for `CacheStack` event payloads, giving TypeScript autocomplete on `on()` / `once()` / `emit()`.
- **`EvictionPolicy`** option (`'lru' | 'lfu' | 'fifo'`) on `MemoryLayer`.
- **`CacheMetricsSnapshot.resetAt`** timestamp (ms epoch) recorded when metrics were last reset.
- **`CacheStackOptions.maxProfileEntries`** — limits the number of in-memory access profile and circuit-breaker entries to prevent unbounded memory growth (default: 100 000).
- **Prometheus exporter** now exports `layercache_hit_rate` gauge alongside all counter metrics.

### Changed
- **`CacheStack` internals refactored**: TTL resolution moved to `TtlResolver`, circuit-breaker logic to `CircuitBreakerManager`, and metrics tracking to `MetricsCollector`. Public API is unchanged.
- **`RedisLayer.clear()`** now deletes keys in batches of 500 instead of loading all matching keys into memory first, preventing OOM on large datasets.
- **`PatternMatcher.matches()`** replaced regex-based glob matching with a linear-time DP algorithm, eliminating the ReDoS vulnerability.
- **`CacheStack.restoreFromFile()`** now uses a prototype-pollution-safe JSON reviver and gives a more descriptive error on invalid files.
- **`cli`** validates the `--redis` URL before connecting and sets a 5 s connect timeout; connection errors are reported to stderr with a non-zero exit code.
- **Debug log entries** for fetch operations now include `durationMs`.
- **Circuit-breaker error messages** now include the remaining cooldown in seconds, e.g. `Circuit breaker is open for key "user:1" (resets in 12s)`.
- **`CacheStack` constructor** emits a `console.warn` deprecation notice when `publishSetInvalidation` is used; prefer `broadcastL1Invalidation`.
- **`tsconfig.json`** adds `noUncheckedIndexedAccess: true` for stricter array/object index safety.
- **GitHub Actions** workflow now tests against Node.js 18, 20, and 22 in a matrix, and uploads coverage to Codecov on Node 20.

### Deprecated
- **`CacheStackOptions.publishSetInvalidation`** — use `broadcastL1Invalidation` instead. Will be removed in v2.

### Fixed
- **Memory leak**: `accessProfiles` map is now pruned when it exceeds `maxProfileEntries` entries, and cleared/per-key deleted on `clear()` / `delete()` respectively.
- **Memory leak**: `circuitBreakers` map now has bounded size with auto-pruning.

## [1.0.2] — 2025-04-01

### Fixed
- Initial public release patch fixes.

## [1.0.0] — 2025-03-15

### Added
- Initial release with `MemoryLayer`, `RedisLayer`, `CacheStack`, stampede prevention, tag & pattern invalidation, stale-while-revalidate, stale-if-error, adaptive TTL, circuit breaker, graceful degradation, compression, NestJS module, Fastify plugin, tRPC middleware, GraphQL helper, and admin CLI.
