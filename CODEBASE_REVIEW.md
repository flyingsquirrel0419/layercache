# Layercache Codebase Review & Growth Plan

> Review date: 2026-04-04 | Version reviewed: 1.0.1

---

## Executive Summary

Layercache is a well-engineered multi-layer caching library with a clean architecture and strong feature set (stampede prevention, distributed invalidation, stale strategies). The codebase is type-safe, well-documented, and production-capable. However, several **reliability issues**, **missing guardrails**, and **feature gaps** limit adoption potential. This document organizes findings into **what to fix** (bugs/quality) and **what to add** (features for growth).

---

## Part 1: What to Fix

### P0 - Critical (Data Loss / Silent Failures)

#### 1. Missing error handling in `RedisInvalidationBus` JSON.parse
**File:** `src/invalidation/RedisInvalidationBus.ts:23`
```ts
const message = JSON.parse(payload) as InvalidationMessage
```
- Malformed payload crashes the listener, silently killing cross-instance invalidation for all subsequent messages.
- **Fix:** Wrap in try-catch, log and skip malformed messages.

#### 2. Redis pipeline errors silently ignored in `RedisLayer.getMany()`
**File:** `src/layers/RedisLayer.ts:60-71`
```ts
const [, payload] = result  // ignores error element
```
- `pipeline.exec()` returns `[error, result]` tuples. The error element is destructured away. Individual command failures (e.g., WRONGTYPE) are invisible.
- **Fix:** Check `result[0]` for errors; treat errored entries as cache misses.

#### 3. Deserialization failures crash cache reads
**File:** `src/layers/RedisLayer.ts:47, 70`
- If cached data is corrupted or the serializer format changes between deployments, `deserialize()` throws, propagating to the caller.
- **Fix:** Wrap deserialization in try-catch; treat corrupted entries as cache misses and delete the bad key.

#### 4. Async listener errors silently swallowed
**File:** `src/invalidation/RedisInvalidationBus.ts:21-25`
- The async `listener` is attached via `.on('message', ...)`. If `handler()` rejects, there is no error tracking. Cross-instance invalidation silently stops working.
- **Fix:** Add try-catch inside the listener with error logging.

---

### P1 - High (Correctness / Edge Cases)

#### 5. Race condition in `StampedeGuard` mutex cleanup
**File:** `src/stampede/StampedeGuard.ts:12-14`
```ts
if (!mutex.isLocked()) {
  this.mutexes.delete(key)
}
```
- Between `isLocked()` check and `delete()`, another caller could acquire the same mutex. This can cause unbounded Map growth under high concurrency.
- **Fix:** Use a reference count or wrap the check-and-delete in a synchronous critical section.

#### 6. No input validation on cache keys
**File:** `src/CacheStack.ts:88`
- Empty strings, extremely long keys, or keys with special characters are passed directly to Redis.
- `RedisTagIndex` uses `encodeURIComponent()` on keys, but `TagIndex` (in-memory) does not, causing inconsistent behavior when switching implementations.
- **Fix:** Validate keys at the `CacheStack` level (non-empty, max length, consistent encoding).

#### 7. `mget` with duplicate keys causes redundant work
**File:** `src/CacheStack.ts:151-204`
- Duplicate keys in the entries array result in duplicate fetches. No deduplication occurs.
- **Fix:** Deduplicate keys internally and map results back to original positions.

#### 8. Background refreshes can start after `disconnect()`
**File:** `src/CacheStack.ts:236`
- `disconnect()` awaits `Promise.allSettled(backgroundRefreshes)` but doesn't set a flag to prevent new refreshes from being scheduled during shutdown.
- **Fix:** Add an `isDisconnecting` flag checked before scheduling new background refreshes.

#### 9. Multiple subscriptions on same `RedisInvalidationBus`
**File:** `src/invalidation/RedisInvalidationBus.ts:27-28`
- Calling `subscribe()` multiple times adds duplicate listeners without tracking.
- **Fix:** Track subscription state and prevent re-subscription.

---

### P2 - Medium (Quality / Maintainability)

#### 10. Unsafe type casts without runtime validation
- `src/layers/RedisLayer.ts:70` — `payload as Buffer` assumes type without checking.
- `src/internal/StoredValue.ts:89` — `as T | null` cast bypasses validation.
- `src/invalidation/RedisInvalidationBus.ts:23` — `as InvalidationMessage` on `JSON.parse` output.
- **Fix:** Add runtime checks or use a schema validator for external data boundaries.

#### 11. No validation of conflicting configuration
**File:** `src/CacheStack.ts:74-86`
- `stampedePrevention: false` with `singleFlightCoordinator` set doesn't warn. `negativeTtl` with negative numbers isn't caught early.
- **Fix:** Validate configuration in the constructor and throw on conflicts.

#### 12. Code duplication in layer operations
**File:** `src/CacheStack.ts:543-550, 588-594`
- The "try bulk operation, fall back to individual" pattern appears twice identically.
- **Fix:** Extract to a helper like `bulkOrIndividual(layer, op, keys)`.

#### 13. Confusing `publishSetInvalidation` naming
**File:** `src/CacheStack.ts:326`
- Default `true` means every `set()` broadcasts an invalidation. The name suggests "publish the set" rather than "invalidate remote L1 copies after set".
- **Fix:** Rename to `broadcastL1Invalidation` or similar.

---

## Part 2: What to Add (Growth Features)

### Tier 1 — High Impact / Attracts Users

#### A. Observability & Events
**Why:** Developers won't adopt a cache library they can't debug in production.
- Add an optional `EventEmitter` with events: `hit`, `miss`, `set`, `delete`, `error`, `backfill`, `stale-serve`, `stampede-dedupe`.
- Add per-layer hit/miss breakdown in metrics (`hitsByLayer: Record<string, number>`).
- Add separate `negativeCacheHits` metric.
- Consider OpenTelemetry trace/span integration.

**Impact:** This is the #1 missing feature vs. competitors. Libraries like `cacheable` and `keyv` offer event hooks. Without observability, ops teams will veto adoption.

#### B. Cache Warming / Preloading API
**Why:** Cold-start performance is a major concern for production deployments.
```ts
await cache.warm([
  { key: 'config:feature-flags', fetcher: () => fetchFlags(), ttl: 300 },
  { key: 'catalog:top-100', fetcher: () => fetchTop100(), ttl: 600 },
])
```
- Batch-populate cache on startup or after deploys.
- Support priority ordering and concurrency limits.

**Impact:** Solves a real production pain point. Differentiates from simpler libraries.

#### C. Decorator / Wrapper Pattern Support
**Why:** Most caching in Node.js apps wraps function calls. A decorator API reduces boilerplate dramatically.
```ts
const getUser = cache.wrap('user', fetchUser, { ttl: 60, tags: ['users'] })
const user = await getUser(123) // key becomes "user:123"
```
- Auto-generate cache keys from function arguments.
- Support class method decorators for NestJS/TypeScript users.

**Impact:** Reduces integration effort from ~10 lines to 1 line per cached function. This is how `node-cache-manager` gained adoption.

#### D. TTL / Expiry Strategies
**Why:** Fixed TTLs are too rigid for most real-world use cases.
- **Sliding window TTL:** Reset TTL on each access (keep hot data alive).
- **Adaptive TTL:** Automatically adjust TTL based on access frequency.
- **Explicit refresh-ahead:** Proactively refresh keys before they expire (not just stale-while-revalidate).

**Impact:** Addresses common complaints about cache libraries being too simplistic.

#### E. Comprehensive Test Suite
**Why:** Current tests cover happy paths but many edge cases are untested. Contributors and enterprise adopters need confidence.
- Add tests for: deserialization failures, Redis connection drops mid-operation, concurrent mixed read/write, bus message corruption, shutdown during active refreshes.
- Add integration tests with real Redis (via testcontainers or similar).
- Add a coverage report badge to README.

**Impact:** Enterprise teams check test coverage before adopting. A coverage badge signals maturity.

---

### Tier 2 — Medium Impact / Differentiators

#### F. Cache Namespaces / Scoping
```ts
const userCache = cache.namespace('users')
const productCache = cache.namespace('products')
await userCache.get('123')       // key: "users:123"
await userCache.clear()          // only clears "users:*"
```
- Logical isolation without separate CacheStack instances.
- Safe `clear()` scoped to namespace.

**Impact:** Common pattern in larger apps. Avoids key collision bugs.

#### G. Graceful Degradation / Circuit Breaker
- If Redis is down, automatically fall back to memory-only mode.
- If upstream fetcher consistently fails, trip a circuit breaker.
- Emit events on state transitions (closed -> open -> half-open).

**Impact:** Production resilience is a key selling point. Currently, a Redis outage can cascade to application failures.

#### H. Compression Support
```ts
new CacheStack({
  compression: 'gzip', // or 'lz4', 'brotli'
  compressionThreshold: 1024, // only compress values > 1KB
})
```
- Reduce Redis memory usage and network bandwidth for large values.
- Transparent to the caller.

**Impact:** Meaningful cost reduction for users caching large JSON payloads.

#### I. Cache Statistics Dashboard / Debug Endpoint
- Built-in middleware (Express/Fastify) that exposes `/cache/stats` endpoint.
- Show hit rates, top keys, layer utilization, memory usage.

**Impact:** Makes the library "batteries-included" for debugging.

#### J. First-Class Logging
- Currently uses `console.debug` behind `DEBUG=layercache:debug`.
- Replace with a pluggable logger interface (`logger: { debug, info, warn, error }`).
- Default to no-op; support pino, winston, console out of the box.

**Impact:** Every production Node.js app has a logger. Forcing `console.debug` is a non-starter for many teams.

---

### Tier 3 — Nice to Have / Ecosystem

#### K. Framework Integrations
- **Fastify plugin** (Fastify is growing faster than Express).
- **tRPC middleware** for automatic procedure caching.
- **GraphQL resolver cache** for Apollo/Yoga.
- Improve existing NestJS package (currently minimal at 30 lines).

#### L. Persistence / Backup
- Periodic snapshot of in-memory layer to disk (for fast restarts).
- Import/export cache state for migration scenarios.

#### M. Admin CLI
```bash
npx layercache stats --redis redis://localhost:6379
npx layercache invalidate --tag "user:123"
npx layercache keys --pattern "session:*"
```
- Operational tool for cache management without writing code.

#### N. Better Documentation & Ecosystem
- **Comparison page:** Side-by-side with `node-cache-manager`, `keyv`, `cacheable`.
- **Migration guide:** From `node-cache-manager` to `layercache`.
- **Video tutorial** or interactive playground.
- **Performance benchmark page** with reproducible results.
- **Logo and branding** for npm/GitHub presence.

---

## Part 3: Prioritized Roadmap

### Phase 1 — Reliability (Week 1-2)
Fix all P0 and P1 issues. These are bugs that can cause silent data loss or incorrect behavior in production.

| # | Item | Effort |
|---|------|--------|
| 1 | Error handling in RedisInvalidationBus | S |
| 2 | Pipeline error checking in RedisLayer | S |
| 3 | Deserialization failure handling | S |
| 4 | Async listener error handling | S |
| 5 | StampedeGuard race condition | M |
| 6 | Key/tag validation | M |
| 7 | mget deduplication | S |
| 8 | Shutdown safety (disconnect flag) | S |
| 9 | Duplicate subscription prevention | S |

### Phase 2 — Developer Experience (Week 3-4)
Add the features that make developers choose layercache over alternatives.

| # | Item | Effort |
|---|------|--------|
| A | Observability & events | L |
| C | `cache.wrap()` decorator API | M |
| J | Pluggable logger interface | S |
| E | Comprehensive test suite + coverage badge | L |
| 11 | Config validation | S |

### Phase 3 — Production Features (Week 5-8)
Features that enterprise teams need before adopting.

| # | Item | Effort |
|---|------|--------|
| B | Cache warming API | M |
| F | Namespaces / scoping | M |
| G | Circuit breaker / graceful degradation | L |
| D | Sliding/adaptive TTL | M |
| H | Compression support | M |

### Phase 4 — Ecosystem (Ongoing)
Build community and integrations.

| # | Item | Effort |
|---|------|--------|
| K | Framework integrations (Fastify, tRPC) | L |
| N | Documentation, migration guides, branding | M |
| I | Stats dashboard middleware | M |
| M | Admin CLI | M |
| L | Persistence / backup | L |

**Effort scale:** S = < 1 day, M = 1-3 days, L = 3-5 days

---

## Competitive Landscape

| Feature | layercache | node-cache-manager | keyv | cacheable |
|---------|-----------|-------------------|------|-----------|
| Multi-layer | **Yes** | Yes | Plugin | No |
| Stampede prevention | **Yes** | No | No | No |
| Distributed invalidation | **Yes** | No | No | No |
| Tag-based invalidation | **Yes** | No | No | Yes |
| Stale-while-revalidate | **Yes** | No (plugin) | No | No |
| Event hooks | **No** | Yes | Yes | Yes |
| Wrap/decorator API | **No** | Yes | No | No |
| Pluggable logger | **No** | No | No | Yes |
| TypeScript-first | **Yes** | Partial | Yes | Yes |
| Compression | **No** | No | No | Yes |
| Namespaces | **No** | No | Yes | Yes |

**Layercache's moat:** Stampede prevention + distributed invalidation + stale strategies in a single, TypeScript-first package. No competitor combines all three.

**Biggest gaps vs. competitors:** Event hooks, wrap API, pluggable logger, namespaces.

---

## Summary

Layercache has a **strong technical foundation** with genuinely differentiated features (stampede prevention, distributed pub/sub invalidation, stale strategies). The architecture is clean and extensible.

**To attract more users:**
1. **Fix the 4 critical bugs first** — silent failures in production will kill word-of-mouth.
2. **Add observability (events + metrics)** — this is the #1 blocker for production adoption.
3. **Add `cache.wrap()` API** — reduces integration effort 10x, the single biggest DX win.
4. **Add pluggable logging** — non-negotiable for enterprise teams.
5. **Expand test coverage with a badge** — signals maturity to potential adopters.

The core value proposition is strong. The path to growth is primarily about **reliability, developer experience, and ecosystem** rather than new cache features.
