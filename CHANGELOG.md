# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Breaking

- `createTrpcCacheMiddleware` and `cacheGraphqlResolver` now require a `keyResolver` and no longer accept `allowImplicitContextCaching`. Implicit path+input or argument-only keys could not distinguish authenticated callers and could leak one user's data to another; pass a `keyResolver` that includes every input and request-context attribute that affects the result.

### Security

- Hardened implicit Express/Hono URL caching so requests carrying common authentication headers (`authorization`, `cookie`, `set-cookie`, `x-api-key`, `x-session-id`, `x-auth-token`, `x-forwarded-user`) bypass implicit URL-only caching unless a custom `keyResolver` is supplied, preventing one user's authenticated response from being served to another. Header names are matched case-insensitively, and header accessors (`Headers#get`, `get()`/`header()`) are invoked with the correct receiver.
- Added `RedisInvalidationBus.requireSignature` so deployments can fail fast at construction when `signingSecret` is missing, preventing an unsigned invalidation channel that any Redis publisher could forge messages on. Zero-length strings and buffers are treated as missing secrets, and the requirement is validated before a default subscriber is created.

## [4.0.0] — 2026-07-19

### Breaking

- Public `CacheStack`, namespace, `wrap()`, `getOrSet()`, and `mget()` reads now return `undefined` for misses and negative-cache entries instead of `null`, resolving issue #90.
- Read-through fetchers now cache `null` as a regular value by default, and `getOrThrow()` returns stored nulls while throwing only for `undefined`. Set `cacheNullValues: false` when null represents absence.
- Automatically derived structured `wrap()` keys use the `j2:` schema, so old `j:` entries become cold misses and expire naturally.
- Write coordination and generation cleanup now apply finite default limits and can reject saturated work with `CacheWriteSaturationError`.

### Security

- Fixed implicit Express/Hono private URL caching so requests containing sensitive query parameters, including OAuth `client_secret` and client assertions, bypass implicit URL-only caching unless a custom `keyResolver` is supplied.
- Fixed namespace clearing so `CacheNamespace.clear()` invalidates the delimiter-bound namespace prefix (for example `tenant:`), preventing sibling namespace eviction such as `a` clearing `ab`.
- Fixed DiskLayer protected reads so plaintext legacy payloads are rejected when `encryptionKey` or `signingKey` is configured. Added `allowLegacyPlaintext` as an explicit migration-only opt-in.
- Fixed generation cleanup to stream old-generation keys into bounded batches and cap its unique-key discovery set at 10,000 entries by default.
- Changed OpenTelemetry instrumentation to export `layercache.key_hash` by default. Raw `layercache.key` attributes now require `includeRawKeyAttributes: true`.
- Hardened snapshot commits by rejecting symlinked target parents immediately before the final rename.
- Hardened CLI invalidation so every wildcard-only pattern such as `*`, `**`, and `?*` requires `--force`, matching the default full-cache invalidation guard.
- Hardened CLI Redis connection errors by scrubbing Redis URLs from nested error messages before printing them.
- Added a Redis invalidation warning when `RedisInvalidationBus` is constructed without `signingSecret` and a logger is provided.
- Hardened the docs playground by keeping the token-bearing worker message sender outside user-code global reach, in addition to sandboxed iframe, Blob Worker, and token checks.
- Prevented plain objects from forging native structured cache-key tags and rotated structured argument keys from `j:` to `j2:` so previously ambiguous entries are not reused.
- Prevented stale single and bulk writes from repopulating invalidated keys or deleting newer `mset()` values by sharing one per-key ordering boundary and checking fences after backend writes.
- Bounded retained write-ordering state with configurable global, active-key, and per-key limits that reject saturation with `CacheWriteSaturationError`.
- Replaced reusable per-key epoch values with monotonic tokens so maintenance pruning cannot create an ABA window for stale writes.
- Fixed per-key fetch rate limiting so a ready key can preempt a later shared drain timer chosen by a throttled key.

### Changed

- Updated Vite and related development-only transitive dependencies to resolve the release audit finding.
- Updated the README and benchmarking guide with a fresh reproducible 4.0.0 baseline covering direct, HTTP, payload, slow-Redis, queue-amplification, memory-pressure, invalidation, and distributed single-flight scenarios.
- Corrected benchmark TTLs to use the documented millisecond units and updated Autocannon plus its Hyperid override so the HTTP benchmark runs on current Node.js with zero npm audit findings.
- Updated API, migration, serialization, resilience, integration, architecture-decision, and security documentation for v4 miss/null semantics, finite cleanup/write limits, structured-key rotation, HTTP credential handling, CLI guard, and playground isolation boundary.

### Tests

- Added regression coverage for all security fixes and hardening changes, including shared drain-timer preemption, disposal of queued rate-limited work, epoch rollover, empty serialized writes, symlinked snapshot bases, and serializer undefined behavior. The unit suite reports 672 passing tests and 24 skipped tests; the real Redis integration suite adds 25 passing tests.
- Added docs-web content assertions for the updated security-sensitive documentation.

## [3.1.1] — 2026-06-14

### Fixed

- Fixed the `FetchRateLimiter` queue item typing under strict TypeScript checks by aligning queued task and resolver storage with the bucket queue's `unknown` value boundary.
- Restored the `lint` and `lint:fix` scripts to direct `biome` invocations, since npm scripts already resolve local binaries from `node_modules/.bin`.
- Added rate limiter regression coverage for rejected queued tasks continuing to drain and for corrupted pending-queue defensive cleanup, raising the suite to 601 passing tests and overall statement coverage to 97.13%.

### Security

- Resolved development dependency audit findings by updating the lockfile to use `tmp@0.2.7`, `tsx@4.22.4`, and `esbuild@0.28.1`.
- Added an `esbuild` override so transitive dev tooling no longer resolves the vulnerable `0.27.x` line.

## [3.1.0] — 2026-05-17

### Added

- `cacheNullValues` can store fetched `null` values as regular cache values instead of treating them as misses or negative-cache entries.
- `CacheStack.getEntry()` and namespace `getEntry()` expose entry metadata so callers can distinguish stored `null` values, negative-cache entries, stale entries, and misses.
- `CacheStack.captureMetrics()` runs an async operation and returns the result plus only the metrics emitted during that operation.
- Circuit breakers can now use `scope: 'shared'` and `breakerKey` to group related fetches by backend dependency instead of only by cache key.
- Fetcher rate limits support `queueOverflow: 'reject' | 'bypass'` so saturated queues fail explicitly by default or deliberately bypass the limiter.
- `DiskLayer.maxWriteQueueDepth` bounds the serialized disk write queue and can be disabled with `false`.

### Changed

- TagIndex wildcard matching now prunes candidates by literal prefix and uses iterative traversal to avoid recursive wildcard depth limits.
- TagIndex repeated touches are throttled with `touchRefreshIntervalMs` to reduce hot-path LRU churn.
- Namespace metrics now use async-local metric capture and preserve metrics from operations that throw.
- Distributed single-flight waiters back off polling while respecting the configured timeout.
- Test coverage now includes fetcher-rate-limit interval draining, cleanup timer rearming, bucket hard-limit failure, and disposed-bucket safeguards, raising the overall statement baseline above 96.9%.

### Fixed

- Circuit breaker buckets are namespaced internally so per-key, shared, and custom breaker ids cannot collide.
- Enum-like runtime validation now rejects empty-string `scope` and `queueOverflow` values.
- `CacheStack.getEntry()` now records read metrics, touches tag metadata, backfills faster layers, deletes expired entries, and emits hit/miss events consistently with the normal read path.
- Playground stale-while-revalidate refreshes now use the same circuit-breaker accounting as cache misses.

## [3.0.0] — 2026-05-05

### Breaking

- `RedisTagIndex` now defaults `knownKeysShards` to 16 instead of the legacy single known-key set. Current releases still read the legacy `<prefix>:keys` set with a warning, but existing Redis tag indexes should be migrated with `layercache migrate-tag-index` before mixed-version or long-lived deployments rely on the sharded layout.
- Production CLI runs now reject plaintext `redis://` URLs unless `--allow-plaintext` is explicitly passed. Use `rediss://` for production Redis endpoints, or pass the override only for trusted private networks.
- Implicit Express/Hono URL cache keys now omit sensitive query parameters such as `api_key`, `apikey`, `private_key`, and `credentials`. Existing entries keyed with those parameters included will not be reused by the normalized key path.

### Added

- CLI `migrate-tag-index` migrates legacy RedisTagIndex known-key sets into the current sharded layout.
- CLI `--limit` allows explicit scan caps for `stats`, `keys`, and pattern-based `invalidate` commands.
- `RedisInvalidationBus` supports optional HMAC-SHA256 message signing with `signingSecret`.
- `RedisGenerationStore` persists, initializes, sets, and atomically bumps generation values in Redis for multi-instance deployments.
- `CacheStack.getGeneration()` returns the active generation number so callers can persist generation rotations after `bumpGeneration()`.

### Changed

- `RedisTagIndex` now defaults `knownKeysShards` to 16 and reads the legacy single-set layout with a warning until migrated.
- Docs-web CLI, distributed deployment, invalidation, API, and framework integration docs now reflect current Redis TLS, scan-limit, signed invalidation, tag-index migration, and HTTP cache-key behavior.
- Docs playground examples now use current write-option syntax for tags, millisecond TTL option objects, `null` cache misses, and `shouldCache` examples.
- Docs-web migrated from Next.js to Rspress while preserving robots.txt, sitemap output, markdown-oriented content, and the interactive playground.
- Docs deployment now targets GitHub Pages with the Rspress base path and sitemap configured for `https://flyingsquirrel0419.github.io/layercache`.
- Cache backfill writes now start eligible upper-layer writes in parallel while preserving per-layer failure handling, metrics, and events.
- Pruning hot paths now avoid full-map sorting for cache maintenance, TTL access profiles, and TagIndex known-key tracking.

### Fixed

- Express and Hono cache middleware now avoid storing non-2xx JSON responses.
- Hono cache middleware now respects status set via `context.status(status)` before `context.json(body)`.
- CLI Redis scans now default to 100,000 keys instead of 1,000,000 to reduce memory exposure.
- TagIndex known-key pruning no longer removes tag mappings, preserving tag-based invalidation even when `maxKnownKeys` trims prefix/pattern indexes.
- Distributed single-flight waiters that time out now re-enter the coordinator so only a new lock winner fetches after leader failure.
- API docs now call out process-local adaptive TTL counters and document generation persistence for deployments that need deterministic generation state across restarts.

## [2.1.0] — 2026-05-03

### Added

- **Exact-key invalidation aliases** — `invalidateByKey()` and `invalidateByKeys()` now mirror `delete()` and `mdelete()` while matching the `invalidateBy*` API family.
- **Exact-key stale-preserving expiration** — `expireByKey()` and `expireByKeys()` mark specific keys stale without deleting their stale-while-revalidate / stale-if-error windows.
- **Namespace exact-key APIs** — `CacheNamespace` now exposes the same exact-key invalidation and expiration helpers with namespace-scoped keys.
- **Public type-definition descriptions** — JSDoc comments now cover the public TypeScript surface so editor hover/autocomplete can describe methods, options, metrics, layers, serializers, integrations, and helpers.

### Changed

- Version bumped from `2.0.0` to `2.1.0`.
- Docs-web package metadata and landing page version badge now reflect `2.1.0`.
- API docs now document exact-key invalidation aliases and stale-preserving expiration methods, including the relationship between `invalidateByKey()` / `invalidateByKeys()` and `delete()` / `mdelete()`.
- The docs playground now supports and includes a preset for exact-key invalidation and stale-preserving expiration syntax.
- The docs playground UI was refreshed with clearer light/dark/system theme behavior, visible controls, improved copy fallback behavior, and a clearer two-pane editor/result layout.

### Fixed

- Playground stale-while-revalidate examples now use millisecond TTL options and demonstrate stale serving during background refresh before showing the refreshed value.
- Light-mode playground controls and result panels are now readable after the docs UI refresh.

## [2.0.0] — 2026-05-02

### Breaking

- **TTL values now use milliseconds across the public API** — layer defaults, per-operation `ttl`, `negativeTtl`, `staleWhileRevalidate`, `staleIfError`, `ttlJitter`, `refreshAhead`, adaptive TTL steps, and TTL policy return values are now documented and handled as milliseconds. Redis writes now use `PX`, Redis TTL reads use `PTTL`, and CLI inspect output now reports `ttlMs`.

### Added

- **Stale-preserving expiration APIs** — `expireByTag()`, `expireByTags()`, `expireByPattern()`, and `expireByPrefix()` mark matching entries stale without deleting their stale-while-revalidate / stale-if-error windows, enabling revalidation while still serving existing values.
- **Context-aware cache entry options** — `contextOptions` can derive write-time TTLs and tags from the resolved `{ key, value, kind }` context for both fetched values and direct `set()` operations.
- **Real Redis integration coverage** — Docker Compose, `scripts/run-integration-tests.mjs`, `vitest.integration.config.ts`, and Redis integration suites now cover RedisLayer, RedisInvalidationBus, RedisTagIndex, distributed single-flight, and multi-instance behavior against a real Redis service.
- **Docs web app** — added the `docs-web/` Next.js documentation site with MDX docs, search, playground, `.well-known` API/agent metadata routes, markdown export, sitemap, robots.txt, and UI state tests.
- **BentoCache comparison docs** — README, localized READMEs, and `docs/comparison.md` now include BentoCache feature comparisons.

### Changed

- Version bumped from `1.3.4` to `2.0.0`.
- **Documentation examples now use millisecond TTLs** across README, localized READMEs, root docs, docs-web content, examples, middleware snippets, and migration guides.
- **npm package contents are now limited to runtime build artifacts** by publishing only `dist/` plus npm's always-included metadata.
- **Validation now runs broader CI coverage** with Node.js 20/22, Biome GitHub annotations, real Redis integration tests on Node.js 20, and a validation summary.
- **Test baseline increased to 549 passing tests** with added coverage for context-aware options, stale-preserving expiration, Redis integration behavior, millisecond TTL handling, and docs-web utilities.

### Fixed

- **Stale expiration preserves stale deadlines** instead of discarding stale-while-revalidate / stale-if-error windows when expiring stored envelopes.
- **Invalidation expiration keeps remaining TTLs in milliseconds**, matching the new stored-envelope TTL helpers.
- **CLI inspect and docs-web CLI docs now use `ttlMs`**, aligning CLI output with Redis `PTTL` and millisecond semantics.
- **Docs-web playground cache state reporting** now stays aligned with the worker timeout and state-reporting helpers.
- **Refresh-ahead coverage is no longer timing-sensitive** under Node.js 20 coverage runs.

## [1.3.4] — 2026-04-29

### Changed

- **`CacheStack` read pipeline extracted** into `CacheStackReader` — a dedicated internal module handling all read-path logic (layer reads, fetch orchestration, background refresh, stale policies, fresh-read policies). Public API is unchanged; `CacheStack` now delegates read operations to the reader, reducing core class size from 1,726 to 1,357 lines (-21%).
- **Test suite expanded to 529 tests** (up from 474), including 44 new tests for `CacheStackReader` and 11 new tests for `CacheStackLayerWriter` and `CacheStack` internals.

### Fixed

- **npm audit vulnerabilities resolved** — upgraded `postcss`, `vite`, and `autocannon`/`uuid` dependencies to address 5 security advisories (1 high, 4 moderate). All vulnerabilities now show 0 in `npm audit`.

### Added

- `SECURITY.md` — security policy with supported versions, reporting guidelines, and built-in security features documentation.

## [1.3.3] — 2026-04-26

### Security

- **VULN-1 (HIGH)**: Fixed unbounded memory growth in `CacheStackMaintenance` where the `keyEpochs` Map grew without limit. Added `MAX_KEY_EPOCHS` (50,000) with automatic pruning of the oldest 10% of entries.
- **VULN-2 (MED-HIGH)**: Fixed unbounded per-bucket queue growth in `FetchRateLimiter` where pending callback queues could grow without limit under sustained contention. Added `MAX_QUEUE_PER_BUCKET` (10,000); when exceeded, new requests bypass the rate limiter for availability.
- **VULN-3 (MEDIUM)**: Fixed missing input validation in the CLI. Cache keys, patterns, and tags are now validated using the same rules as the runtime `validateCacheKey()`, `validatePattern()`, and `validateTag()` functions before any Redis operation.
- **VULN-4 (MEDIUM)**: Fixed unsafe mass deletion in the CLI `invalidate` command. Running `invalidate` without `--pattern` or `--tag` (defaults to `*`) now requires a `--force` flag to proceed, preventing accidental cache wipes.
- **VULN-5 (MEDIUM)**: Fixed ineffective pruning in `TagIndex` where `knownKeys` (`Set<string>`) provided no access ordering. Changed to `Map<string, number>` (LRU timestamps) so pruning correctly evicts the least-recently-used entries.
- **VULN-6 (MEDIUM)**: Fixed TOCTOU race condition in snapshot file writes. Centralized atomic write logic (temp file + `fs.rename`) into `CacheSnapshotFile` as reusable utilities (`atomicWriteTempPath`, `commitAtomicWrite`).
- **VULN-7 (LOW)**: Fixed memory leak in `CacheStack` where expired degradation entries in `layerDegradedUntil` were never cleaned up. Entries are now deleted on read when their degradation period has expired.
- **VULN-8 (LOW)**: Replaced `Math.random()` with `crypto.randomBytes`-based CSPRNG in `TtlResolver` for TTL jitter calculations. The deterministic test mock was updated accordingly.
- **VULN-9 (LOW)**: Upgraded background refresh error logging from `debug` to `warn` level so that refresh failures and timeouts are visible in production logs.

## [1.3.2] — 2026-04-17

### Changed
- Version bumped from `1.3.1` to `1.3.2`.
- The separate NestJS workspace package and example were removed; `layercache` is now the only published package path documented in this repository.

### Fixed
- Framework integration examples in `docs/api.md` now import from the root `layercache` package, matching the actual package export map.

## [1.3.1] — 2026-04-17

### Added
- `PayloadProtection` for optional DiskLayer at-rest protection with AES-256-GCM encryption or HMAC-SHA256 signing.
- `DiskLayer` options `encryptionKey` and `signingKey` for protected on-disk payloads, plus regression coverage for encrypted, signed, tampered, wrong-key, and MessagePack-backed disk entries.
- `CacheStackOptions.stampedeMaxInFlight` and `CacheStackOptions.stampedeEntryTimeoutMs` so stampede-guard limits and per-entry timeouts can be configured from the main `CacheStack` API.
- New CLI coverage for `--require-tls`, plus new RedisLayer, DiskLayer, StampedeGuard, and CacheStack stampede-option regression tests.

### Changed
- Version bumped from `1.3.0` to `1.3.1`.
- `README.md` now reflects the current validation baseline with **467 passing tests**.
- `README.md` performance docs now include a recent `bench:slow-redis` sample plus the matching `memory-pressure` results.
- `DiskLayer.maxFiles` now defaults to `50_000`; `Infinity` remains available as an explicit opt-out for bounded file eviction.
- `StampedeGuard` now supports configurable in-flight limits and entry timeouts, and `CacheStack` now wires those options through its built-in fetch dedupe path.
- Error messages that include cache keys now truncate long keys across `CacheStack`, `CircuitBreakerManager`, `MemcachedLayer`, `RedisLayer`, and `StampedeGuard`.

### Fixed
- `DiskLayer` now preserves `Buffer` serializer payloads while applying optional payload protection, so MessagePack-backed disk entries continue to round-trip correctly.
- `RedisLayer` key validation now applies consistently to batch operations (`getMany`, `setMany`, `deleteMany`) as well as single-key operations.
- `JsonSerializer.deserialize()` now wraps `JSON.parse` failures with a clearer serializer-specific error message.
- `createInstanceId()` no longer falls back to `Math.random()` and now requires a cryptographic random source.
- CLI Redis handling now warns on plaintext `redis://` URLs and can reject them outright with `--require-tls`.

### Security
- Disk-backed cache payloads can now be encrypted or signed at rest, with tampering and wrong-key reads treated as cache misses.
- Stats endpoint helpers now emit explicit warnings when public access is enabled without authorization callbacks.
- `RedisLayer` now rejects empty keys, overly long keys, control characters, and surrogate code points even when used directly outside `CacheStack`.

## [1.3.0] — 2026-04-14

### Added
- Real Redis-backed benchmark harnesses for direct cache behavior, HTTP throughput, edge cases, slow Redis, queue amplification, and multi-process fan-out.
- New benchmark utility coverage and Redis single-flight coordinator tests.

### Changed
- Version bumped from `1.2.9` to `1.3.0`.
- `README.md` now reflects the current validation baseline with **431 passing tests**.

### Fixed
- `RedisLayer` and `RedisSingleFlightCoordinator` now support per-command Redis timeouts via `commandTimeoutMs`.
- `CacheStack` now degrades gracefully when the distributed single-flight coordinator fails and preserves local single-flight collapse for concurrent misses.
- `StampedeGuard` now shares in-flight promises across concurrent callers instead of serializing them through a mutex queue.

## [1.2.9] — 2026-04-10

### Fixed
- `CacheStack.withTimeout()` no longer misidentifies resolved `null` values as the race-loser branch, preventing incorrect error throws when cached values are legitimately null.
- `CacheStack.mget()` fast path now skips degraded layers and correctly increments stale-hit counters, matching the behavior of the slow path.
- `CacheStack.disconnect()` now signals all in-flight background refreshes to abort, waits up to 5 seconds for them to settle, and cleans up all timers — preventing dangling promises and event-loop leaks after shutdown.
- `CacheStackLayerWriter.executeLayerOperations()` simplified a tautological failure check to `failures.length === operations.length`, making the "all layers failed" condition clearer.
- `CacheStackSnapshotManager.importState()` now respects `shouldSkipLayer` and catches per-layer write failures with `handleLayerFailure`, preventing snapshot restores from crashing on a single bad layer.
- `CacheStackSnapshotManager.sanitizeSnapshotValue()` explicitly calls `sanitizeStructuredData` after serializer round-trip to guarantee prototype-pollution protection even with custom serializers.
- `CacheStackSnapshotManager` temp file names now use `crypto.randomBytes` instead of `Math.random()` to prevent predictable temp-file names.
- `FetchRateLimiter.drain()` now defers re-entrancy via `setTimeout(0)` to avoid event-loop starvation under heavy contention.
- `FetchRateLimiter.bucketState()` throws a hard error after failed bucket eviction instead of silently continuing with an invalid state.
- `RedisInvalidationBus.subscribe()` now serializes concurrent callers through a Promise chain, eliminating a race condition where overlapping subscribes could clobber each other's subscription state.
- `CacheKeySerialization.serializeKeyPart()` percent-encodes `%` and `:` in string key parts, preventing key collisions from keys that naturally contain colons.
- `StructuredDataSanitizer` now builds sanitized arrays with explicit `[]` + `push()` instead of `.map()`, ensuring the result is always a true Array instance even if `Array.prototype` has been tampered with.
- `DiskLayer` temp file names now use `crypto.randomBytes` instead of `Math.random()`.
- `MsgpackSerializer.deserialize()` now includes a comment documenting why `latin1` encoding is correct for binary msgpack payloads.
- CLI `--redis` flag now validates that a value is provided before attempting to connect.
- CLI `scanKeys` now caps results at 1 000 000 keys to prevent unbounded memory usage on large keyspaces.
- CLI auto-run detection now checks for `endsWith('cli.cjs') || endsWith('cli.js')` instead of `includes('cli.')`, preventing false triggers from paths containing `cli.` in directory names.
- `nextOperationId` in `CacheStack` now wraps via modulo `Number.MAX_SAFE_INTEGER` to prevent integer overflow in long-running processes.
- OpenTelemetry integration now wraps span start/end callbacks in try/catch and caps in-memory spans at 10 000 to prevent tracer errors from breaking cache operations.
- `CacheValue` type now has a JSDoc note clarifying `null` ambiguity.

### Added
- `StructuredDataSanitizer.test.ts` — 12 test cases covering primitives, arrays, dangerous key stripping, nested objects, `createObject` factory, and depth/node limits.
- `RedisLayer.compression.test.ts` — 4 tests for `decompressionMaxBytes` enforcement on gzip and brotli payloads.

### Changed
- Test suite now passes with **411 tests** (up from 397).

## [1.2.8] — 2026-04-09

### Changed
- `README.md` now reflects the current validation baseline with **397 passing tests**.
- `CacheStack` now delegates snapshot import/export, invalidation helpers, and layer write orchestration to dedicated internal modules (`CacheStackSnapshotManager`, `CacheStackInvalidationSupport`, `CacheStackLayerWriter`), reducing core class sprawl further.
- OpenTelemetry integration now uses `CacheStack` operation events instead of monkey-patching cache instance methods.
- Shared structured payload sanitization now lives in a single internal utility reused by JSON serialization, MessagePack serialization, and Redis invalidation payload handling.

### Fixed
- `FetchRateLimiter` now exposes `dispose()` and is cleaned up during `CacheStack.disconnect()`, preventing internal timers from surviving shutdown.
- CLI Redis connection errors now mask embedded passwords consistently by routing messages through `maskRedisUrl()`.
- Compression coverage now includes deterministic fuzz-style malformed/truncated payload checks for both gzip and brotli Redis payload paths.
- Vitest now installs a shared Redis mock cleanup hook so `ioredis-mock` listeners are disconnected after each test, preventing `MaxListenersExceededWarning` noise in the full suite.

## [1.2.7] — 2026-04-08

### Changed
- `README.md` now reflects the current validation baseline with **393 passing tests**.

### Added
- Additional coverage-focused regression tests for `CacheStack` read/write paths, stale serving, background refresh coordination, namespace metrics helpers, generation helpers, runtime helpers, and layer/invalidation internals.
- New internal helper modules (`CacheNamespaceMetrics`, `CacheStackGeneration`, `CacheStackMaintenance`, `CacheStackRuntimePolicy`) to split branch-heavy `CacheStack`/`CacheNamespace` responsibilities into directly testable units.

## [1.2.6] — 2026-04-08

### Changed
- `README.md` now reflects the current validation baseline with **328 passing tests**.
- `CacheStack` now delegates key validation, key serialization, and snapshot path/file handling to dedicated internal helpers (`CacheStackValidation`, `CacheKeySerialization`, `CacheSnapshotFile`), reducing class sprawl and making targeted testing easier.

### Fixed
- `tests/internal/TtlResolver.test.ts` no longer hard-codes Asia/Seoul-specific `until-midnight` expectations, so the validation workflow passes consistently on GitHub Actions runners in UTC.

### Added
- `snapshotMaxEntries` and `invalidationMaxKeys` safeguards to cap large snapshot exports and wildcard/tag-based invalidation scans before they fan out across the whole cache.
- Visitor-style key iteration hooks on built-in layers and tag indexes so export and invalidation flows can stream keys instead of materializing full key lists first.
- `DiskLayer.maxEntryBytes` to reject oversized on-disk cache entries before deserialization.
- Additional regression coverage for snapshot restore/export hardening, namespace isolation, serializer sanitization, invalidation safety, large-keyspace management, and refactored `CacheStack` internals; the suite currently passes with **328 tests**.

### Changed
- `persistToFile()` now writes snapshots through a validated temp file in the snapshot directory and streams entries to disk instead of building the full JSON payload in memory first.
- `restoreFromFile()` now reads snapshots through a bounded file-handle path with `snapshotMaxBytes` enforcement and batched import fan-out, reducing memory spikes during restore.
- Built-in invalidation key discovery now prefers streaming key visitors from `MemoryLayer`, `DiskLayer`, `RedisLayer`, `TagIndex`, and `RedisTagIndex` before falling back to array-returning APIs.
- `RedisLayer.size()` now counts keys without first collecting the entire prefixed key list, and `DiskLayer` key scans/deletes now run with bounded concurrency.
- Express and Hono middleware now require explicit opt-in or a custom `keyResolver` before URL-only implicit response caching is enabled.
- Namespace-scoped tags are now prefixed and validated consistently so nested namespaces isolate tag invalidation the same way they isolate keys.

### Fixed
- Cluster-wide and key-level invalidation now prevent stale background refreshes and queued write-behind work from repopulating entries after a clear/delete/invalidate operation.
- Remote invalidation now clears per-key circuit-breaker state on other nodes as well, keeping distributed delete/invalidate behavior aligned with local operations.
- Snapshot restore now validates imported keys with the same cache-key rules as normal writes, and import/export paths now fail fast when entry limits are exceeded.
- Hono cached-hit responses now return the framework `Response`, and the Fastify stats route no longer mixes `reply.send()` with returned bodies.
- `StoredValueEnvelope` validation now rejects invalid TTL metadata and unrealistic timestamp combinations that could otherwise extend stale or negative cache lifetimes.

### Security
- `RedisLayer` now enforces decompression limits while streaming gzip/brotli payloads so compressed cache bombs are rejected before they consume unbounded memory.
- `JsonSerializer`, `MsgpackSerializer`, and `RedisInvalidationBus` now enforce both recursion-depth and total-node limits while stripping dangerous prototype-pollution keys from decoded payloads.
- Snapshot persistence/restore paths now harden against symlink-based escapes and validate namespace prefixes, tags, and restored envelope metadata before data reaches backing layers.
- Stats endpoints now default to protected mode and require explicit public exposure or request authorization before returning cache internals.

## [1.2.5] — 2026-04-07

### Changed
- Nested namespace creation now validates child prefixes up front, matching the cache key restrictions more closely and rejecting empty or control-character prefixes earlier.
- `invalidateByPattern()` now validates pattern length and control characters before scanning tracked keys.
- Express and Hono cache middleware now derive cache keys from normalized URLs without decoding path segments, avoiding encoded-path aliasing.
- `FetchRateLimiter` now evicts idle buckets when scoped throttling cardinality grows too high, and `TtlResolver` / `CircuitBreakerManager` prune state by recency instead of insertion order.
- Cache stats HTTP responses now include `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`.

### Fixed
- `RedisInvalidationBus` now sanitizes parsed JSON payloads before shape validation, stripping prototype-pollution keys from invalidation messages.
- `TagIndex` caps wildcard recursion depth to avoid pathological pattern scans from exhausting the stack.
- `RedisLayer` now logs failed cleanup attempts when deleting a corrupted key after deserialization failure instead of silently swallowing the delete error.

## [1.2.4] — 2026-04-07

### Changed
- `CacheStack` now delegates prefix and pattern invalidation key discovery to a dedicated `CacheKeyDiscovery` helper, reducing class sprawl and isolating layer-scan orchestration.

### Fixed
- `FetchRateLimiter` interval cleanup coverage now uses fake timers instead of wall-clock sleeps, making the validation suite deterministic again.

## [1.2.3] — 2026-04-06

### Added
- `backgroundRefreshTimeoutMs` to bound stale refresh attempts so a hung upstream fetch cannot block future refresh work forever.
- `generationCleanup` to let `bumpGeneration()` asynchronously prune stale generation keys instead of leaving old namespaces behind until TTL expiry.
- **`decompressionMaxBytes`** option on `RedisLayer` (default 64 MiB) to prevent decompression bomb attacks via crafted compressed payloads.
- **MemcachedLayer key validation** — keys are checked for the 250-byte Memcached limit and disallowed whitespace/control characters before every operation.

### Changed
- `invalidateByPattern()` now augments tag-index matches with real layer key scans when a layer exposes `keys()`, making wildcard invalidation more reliable after restarts or partial index loss.
- `invalidateByPrefix()` now uses the same real-layer key fallback path, so hierarchical invalidation remains effective after tag-index state is lost.
- Invalidating by pattern or prefix now routes through a dedicated `CacheKeyDiscovery` helper instead of keeping that scan orchestration inside `CacheStack`.
- The default in-memory `TagIndex` now uses a trie-backed known-key index so prefix and wildcard invalidation avoid full linear scans in the common case.
- `FetchRateLimiter` now schedules per-bucket queues instead of rescanning every queued request on each drain cycle, reducing queue-management overhead under scoped rate limits.
- Write-triggered L1 invalidation now defaults to **off** unless `broadcastL1Invalidation` is explicitly enabled.
- `mget()` now shares a single startup barrier in its non-fast-path instead of re-awaiting startup inside every delegated `get()`.
- `withTimeout()` now observes late-settling background refresh promises so post-timeout rejections do not escape as unhandled promise rejections.
- `TagIndex.clear()` now resets trie node id allocation along with the stored key state.
- The project now targets **Node.js 20+** and the validation workflow runs on Node.js 20 and 22, matching the current Vitest 4 toolchain requirements.
- **Fastify stats route** now requires `exposeStatsRoute: true` (opt-in) instead of being enabled by default, preventing accidental information disclosure.
- **`TagIndex` default `maxKnownKeys`** is now 100,000 instead of unlimited, bounding in-memory trie growth for high-cardinality workloads.
- **Express and Hono middleware** now normalize URLs before deriving cache keys (decode percent-encoding, sort query parameters), preventing cache poisoning via encoding variants.
- README now documents snapshot path restrictions, distributed invalidation guidance, generation cleanup, and background refresh timeout behavior. The suite currently passes with **180 tests**.

### Fixed
- Snapshot persistence is now restricted to a validated base directory by default, reducing accidental path traversal exposure in `persistToFile()` and `restoreFromFile()`.
- Background refresh timeouts now terminate inside the fetch dedupe path so stuck refreshes do not leave the key permanently blocked behind an unfinished guarded fetch.
- `shouldCache` callback failures are isolated from normal fetch success paths, preventing user predicate bugs from surfacing as cache fetch failures.
- `CacheStack` now warns when a shared layer without `keys()` is paired with the default in-memory `TagIndex`, because prefix and pattern invalidation cannot be fully reconstructed after a restart in that configuration.
- `FetchRateLimiter` interval cleanup coverage now uses fake timers instead of wall-clock sleeps, making the validation suite deterministic again.

### Security
- **MsgpackSerializer** now strips `__proto__`, `prototype`, and `constructor` keys during deserialization, matching the existing `JsonSerializer` hardening and preventing prototype pollution via crafted cache payloads.
- **JsonSerializer** now enforces a maximum recursion depth (200) in `sanitizeJsonValue()` to prevent stack overflow on deeply nested payloads stored in the backing cache.
- **StoredValueEnvelope validation** now enforces `kind` enum values (`value`/`empty`), strict numeric types for timestamps, and rejects `freshUntil` values more than 10 years in the future to prevent envelope spoofing.
- **Prometheus label sanitization** now also replaces carriage return (`\r`) characters, closing a potential metric-line injection vector.
- **StampedeGuard** now re-reads the mutex map entry before deletion, preventing a race condition where a concurrently-replaced entry could be incorrectly removed.
- **Express and Hono middleware** now emit cache-write errors via `cache.emit('error', ...)` instead of silently swallowing them.
- **CLI** now masks Redis passwords in error messages to prevent credential leakage in logs and CI output.

## [1.2.2] — 2026-04-06

### Added
- **Scoped fetcher rate limiting** — `CacheRateLimitOptions` now supports `scope: 'global' | 'key' | 'fetcher'` plus `bucketKey` for custom throttling buckets.
- **Redis single-flight lease renewal** — `singleFlightRenewIntervalMs` keeps long-running distributed fetches from dropping their Redis lease mid-flight.
- **Sharded Redis tag indexes** — `RedisTagIndex` now supports `knownKeysShards` to spread `knownKeys` scans across multiple Redis sets in larger deployments.
- **Additional security and resilience coverage** for serializer hardening, DiskLayer validation, scoped throttling, Redis tag sharding, and lease renewal; the suite now passes with **164 tests**.

### Changed
- **README** now documents Redis safety practices, DiskLayer directory guidance, scoped rate limiting, distributed single-flight lease renewal, and the production-focused positioning of the library.

### Fixed
- **DiskLayer input hardening**: `directory` is normalized and validated, malformed disk entries are deleted, and invalid `maxFiles` values are rejected early.
- **JSON deserialization hardening**: `JsonSerializer` now strips dangerous prototype-pollution keys during deserialize, which also protects DiskLayer and JSON-backed Redis payloads.
- **Distributed single-flight duplicate work window**: Redis-backed locks can now be renewed while long-running workers are still in flight.

## [1.2.1] — 2026-04-05

### Added
- **`invalidateByTags(tags, mode)`** — batch tag invalidation with `any` / `all` semantics for multi-tag cache clearing.
- **`invalidateByPrefix(prefix)`** and generation helpers — efficient hierarchical invalidation and generation-based cache rotation for bulk refresh scenarios.
- **`healthCheck()`**, **OpenTelemetry integration**, **Hono middleware**, **write-behind controls**, and richer admin/inspection support for operational debugging.
- **Additional test coverage** for namespaces, integrations, Redis tag indexing, lifecycle safety, and queue behavior; the suite now passes with **158 tests**.

### Changed
- **`CacheStack` startup/disconnect flow** now uses a shared active-state guard helper, and write-behind queuing has safer default batching and queue limits.
- **`RedisTagIndex.keysForPrefix()`** now performs literal prefix filtering after scanning, avoiding glob-style scan mismatches on keys containing special characters.
- **README** was refreshed to document the new invalidation, observability, and runtime-safety behavior.

### Fixed
- **Namespace metrics consistency**: `CacheNamespace.getOrSet()` and `getOrThrow()` now participate in namespace-scoped metrics, and `clear()` uses the prefix invalidation path consistently.
- **Namespace metrics race**: metric diff collection is now serialized so concurrent namespace operations do not overcount each other.
- **Namespace metrics lock scope**: metrics serialization now happens per `CacheStack` instance instead of through a single global mutex, avoiding unnecessary blocking between unrelated caches.
- **Tag intersection performance**: `CacheStack` now intersects multi-tag invalidation candidates with `Set` lookups instead of repeated `Array.includes()` scans.
- **Write-behind queue growth**: deferred writes now flush under bounded defaults instead of growing unbounded until the next interval tick.
- **Redis prefix invalidation correctness**: literal prefixes are now filtered safely after `SSCAN`.
- **Lint / formatting regressions** in the newly added integrations and cache-management code.

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
- **`ttl(key)`** method on `CacheStack`, `CacheNamespace`, `MemoryLayer`, and `RedisLayer` — query remaining TTL.
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
