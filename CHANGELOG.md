# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.0] — 2026-04-05

### Added
- **`getOrThrow(key, fetcher?, options?)`** on `CacheStack` and `CacheNamespace` — throws `CacheMissError` instead of returning `null`.
- **`CacheMissError`** — new error class exported from the package, thrown by `getOrThrow`.
- **`inspect(key)`** on `CacheStack` and `CacheNamespace` — returns detailed metadata about a cache key: which layers hold it, remaining fresh/stale/error TTLs, staleness status, and associated tags.
- **`CacheInspectResult`** type for the `inspect()` return value.
- **`shouldCache`** option on `CacheWriteOptions` — optional predicate called before caching a fetcher's result. Return `false` to skip storage while still returning the value to the caller.
- **`tagsForKey(key)`** optional method on `CacheTagIndex` interface, implemented in both `TagIndex` and `RedisTagIndex`.
- **Nested namespaces** — `CacheNamespace.namespace(childPrefix)` creates child namespaces with compounding key prefixes (e.g. `tenant:abc:posts:mykey`).
- **Per-layer read latency tracking** — `CacheMetricsSnapshot.latencyByLayer` records average, max, and sample count per layer using Welford's online algorithm.
- **`CacheLayerLatency`** type for per-layer latency statistics (`avgMs`, `maxMs`, `count`).
- **Prometheus latency gauges** — `createPrometheusMetricsExporter` now emits `layercache_layer_latency_avg_ms`, `layercache_layer_latency_max_ms`, and `layercache_layer_latency_count` per layer.
- **Express integration** — `createExpressCacheMiddleware(cache, options)` middleware that transparently caches JSON responses with `x-cache: HIT/MISS` headers.
- **NestJS `forRootAsync`** — `CacheStackModule.forRootAsync({ inject, useFactory })` for async configuration via the NestJS DI container.
- **`MemcachedLayer.getEntry()`** — enables `StoredValueEnvelope` support (stale-while-revalidate, stale-if-error) in the Memcached layer.
- **`MemcachedLayer.has()`** — check key existence without deserialization.
- **`MemcachedLayer.getMany()`** — bulk reads for the Memcached layer.
- **`MemcachedLayer.serializer`** option — pluggable serializer (default: JSON), bringing parity with `RedisLayer`.
- **`DiskLayer.maxFiles`** option — limits on-disk cache entries; oldest files (by mtime) are evicted when exceeded.
- **`TagIndex.maxKnownKeys`** option — prevents unbounded memory growth of the in-memory tag index by pruning the oldest 10% of known keys when the limit is exceeded.
- **Tests for `DiskLayer`** — 14 new tests covering get/set/delete/keys/ttl/has/maxFiles/envelope/corrupted files.
- **Tests for `MemcachedLayer`** — 11 new tests covering get/set/delete/getEntry/has/getMany/keyPrefix/serializer/deserialization errors.
- **Tests for `PrometheusExporter`** — 5 new tests covering single/multiple stacks, latency metrics, label sanitization, and zero-state exports.

### Changed
- **`RedisLayer` compression is now fully async** — replaced `gzipSync`/`brotliCompressSync`/`gunzipSync`/`brotliDecompressSync` with their async counterparts to avoid blocking the event loop on large payloads.
- **`MemoryLayer` FIFO semantics clarified** — `getEntry()` no longer increments the access counter for FIFO-evicted caches (access count was unused by FIFO but wastefully bumped). Internal field renamed from `frequency` to `accessCount` for clarity.
- **`RedisInvalidationBus` now supports multiple concurrent subscriptions** — multiple `CacheStack` instances can share a single bus. The previous `throw` on second `subscribe()` call is removed; each subscriber gets an independent unsubscribe handle.
- **CLI `invalidate` command** now deletes keys in batches of 500 instead of issuing a single `DEL` command with all keys, preventing timeout on large key sets.
- **`DiskLayer.keys()`** now returns the original cache key strings (not SHA256 hashes) by storing the key inside each `.lc` file.
- **`DiskLayer.getEntry()`** added — enables `StoredValueEnvelope` passthrough, aligning behavior with `MemoryLayer` and `RedisLayer`.

### Fixed
- **Memory leak in `TagIndex`**: `knownKeys` set now supports a configurable `maxKnownKeys` limit to prevent unbounded growth.
- **`DiskLayer.keys()` returned SHA256 hashes** instead of original cache key names; now returns correct keys.
- **`MemcachedLayer` ignored serializer**: previously hardcoded `JSON.stringify`/`JSON.parse`, now uses the pluggable `CacheSerializer` interface.
- **`MemcachedLayer` lacked `getEntry()`**: `StoredValueEnvelope`-based features (stale-while-revalidate, stale-if-error) silently failed on the Memcached layer.
- **`RedisLayer` sync compression blocked event loop**: large payloads caused latency spikes for other requests.
- **CLI large-key-set deletion**: `invalidate` could timeout when deleting thousands of keys in a single `DEL` command.

## [1.1.0] — 2026-04-05

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

## [1.0.2] — 2026-04-04

### Added
- Growth-roadmap release: `wrap()`, `warm()`, `namespace()`, `getStats()`, snapshot import/export, file persistence, Fastify/tRPC/GraphQL/NestJS integrations, admin CLI, and expanded docs.
- Redis payload compression support and richer operational test coverage.

### Changed
- README and docs were expanded to document the production feature set and usage patterns.

### Fixed
- Follow-up review bugs around tRPC null handling, access-profile cleanup, sliding TTL propagation, method-decorator wrapping, and snapshot validation.

## [1.0.1] — 2026-04-03

### Added
- Operational caching features including negative caching, stale-while-revalidate, stale-if-error, TTL jitter, best-effort writes, and Redis-backed distributed single-flight coordination.
- Stored-value envelopes and dedicated operational feature tests.

## [1.0.0] — 2026-04-03

### Added
- Initial release with `MemoryLayer`, `RedisLayer`, `CacheStack`, stampede prevention, tag & pattern invalidation, stale-while-revalidate, stale-if-error, adaptive TTL, circuit breaker, graceful degradation, compression, NestJS module, Fastify plugin, tRPC middleware, GraphQL helper, and admin CLI.
