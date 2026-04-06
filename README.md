<p align="center">
  <img src="./logo.png" width="520" alt="layercache logo">
</p>

<h1 align="center">layercache</h1>

<p align="center">
  <strong>Production-ready multi-layer caching for Node.js</strong><br>
  <em>Memory, Redis, persistence, invalidation, observability, and resilience in one API.</em>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/layercache"><img src="https://img.shields.io/npm/v/layercache" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/layercache"><img src="https://img.shields.io/npm/dw/layercache" alt="npm downloads"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/npm/l/layercache" alt="license"></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-first-blue" alt="TypeScript"></a>
  <a href="https://github.com/flyingsquirrel0419/layercache"><img src="https://img.shields.io/badge/tests-180%20passing-brightgreen" alt="tests"></a>
</p>

<p align="center">
  <a href="#installation">Installation</a> ·
  <a href="#quick-start">Quick Start</a> ·
  <a href="#core-api">Core API</a> ·
  <a href="#invalidation--freshness">Invalidation</a> ·
  <a href="#integrations--tooling">Integrations</a> ·
  <a href="#contributing">Contributing</a>
</p>

---

## At a glance

- **Fast read path** — combine memory L1, Redis L2, disk, or custom layers behind one API with automatic backfill.
- **Stampede control** — prevent duplicate miss storms with in-process dedupe and optional distributed single-flight.
- **Strong invalidation model** — support tags, batched tags, wildcards, prefixes, and generation-based cache rotation.
- **Built for production failure modes** — serve stale safely, refresh ahead, degrade gracefully, trip circuit breakers, and throttle fetchers.
- **Operational visibility included** — expose metrics, stats, health checks, OpenTelemetry spans, and an admin CLI.
- **Fits real Node stacks** — integrate directly with Express, Fastify, Hono, GraphQL, tRPC, and NestJS.

Most Node.js services hit the same wall:

| Approach | Tradeoff |
|---|---|
| Memory-only cache | Fast, but every instance has a different view of data |
| Redis-only cache | Shared, but every request pays a network round-trip |
| Hand-rolled hybrid cache | Possible, but you rebuild stampede prevention, invalidation, TTL policy, and observability yourself |

`layercache` gives you a single API for layered caching and handles the hard parts for you: read-through fetches, backfill, stale serving, distributed invalidation, rate limiting, persistence, and operational introspection.

```ts
const user = await cache.get('user:123', () => db.findUser(123))
//                                         ↑ only runs on a full miss
```

On a hit, `layercache` serves the fastest available layer and backfills anything above it. On a miss, the fetcher runs once, even under heavy concurrency.

## Performance profile

```text
L1 hit  ~0.01 ms  ← served from memory, zero network
L2 hit  ~0.5  ms  ← served from Redis, backfilled to memory
miss    ~20   ms  ← fetcher runs once, all layers filled
```

## Why teams use it

- **Predictable cache behavior** — layered reads, automatic backfill, negative caching, refresh-ahead, and stale serving.
- **Reliable invalidation** — tags, batched tags, wildcards, prefixes, and generation-based rotation.
- **Production safeguards** — rate limiting, circuit breakers, graceful degradation, compression limits, serializer hardening, and snapshot path validation.
- **Operational visibility** — metrics, health checks, OpenTelemetry spans, stats endpoints, and an admin CLI.
- **Works with your stack** — Express, Fastify, Hono, GraphQL, tRPC, NestJS, CLI, and custom cache layers.

## Feature map

### Core caching

- Layered reads with automatic backfill
- Stampede prevention and optional distributed single-flight
- Bulk reads and writes with layer-level `getMany()` / `setMany()` fast paths
- `wrap()`, namespaces, cache warming, `getOrThrow()`, and `inspect()`

### Invalidation and freshness

- Tag invalidation, batched tag invalidation, wildcard invalidation, and prefix invalidation
- Generation-based invalidation with optional stale-generation cleanup
- Sliding TTL, adaptive TTL, refresh-ahead, stale-while-revalidate, and stale-if-error
- Per-layer TTL overrides, TTL policies, negative caching, and TTL jitter

### Operations and resilience

- Graceful degradation, circuit breakers, scoped fetcher rate limiting, and write-behind
- Persistence to memory snapshots or disk snapshots
- Compression, serializer fallback chains, and MessagePack support
- Health checks, per-layer metrics, latency tracking, and event hooks

### Integrations and tooling

- Express, Fastify, Hono, GraphQL, tRPC, and NestJS integrations
- Redis-backed distributed tag index and invalidation bus support
- Admin CLI for stats, key inspection, and invalidation
- Edge-safe entry point for Worker-style runtimes

## Installation

```bash
npm install layercache
# Redis support (optional)
npm install ioredis
```

---

## Quick start

```ts
import { CacheStack, MemoryLayer, RedisLayer } from 'layercache'
import Redis from 'ioredis'

const cache = new CacheStack([
  new MemoryLayer({ ttl: 60,   maxSize: 1_000 }),   // L1 — local memory
  new RedisLayer({ client: new Redis(), ttl: 3600 }) // L2 — Redis
])

// Fetch pattern — cache miss runs the fetcher, hit skips it entirely
const user = await cache.get<User>('user:123', () => db.findUser(123))

// Manual set / delete
await cache.set('user:123', user)
await cache.delete('user:123')
```

Memory-only setup (no Redis required):

```ts
const cache = new CacheStack([
  new MemoryLayer({ ttl: 60 })
])
```

---

## Core API

### `cache.get<T>(key, fetcher?, options?): Promise<T | null>`

Reads through all layers in order. On a partial hit (found in L2 but not L1), backfills the upper layers automatically. On a full miss, runs the fetcher — if one was provided.

```ts
// Without fetcher — returns null on miss
const user = await cache.get<User>('user:123')

// With fetcher — runs once on miss, fills all layers
const user = await cache.get<User>('user:123', () => db.findUser(123))

// With options
const user = await cache.get<User>('user:123', () => db.findUser(123), {
  ttl: { memory: 30, redis: 600 }, // per-layer TTL
  tags: ['user', 'user:123'],      // tag this key for bulk invalidation
  negativeCache: true,             // cache null fetches
  negativeTtl: 15,                 // short TTL for misses
  staleWhileRevalidate: 30,        // serve stale and refresh in background
  staleIfError: 300,               // serve stale if refresh fails
  ttlJitter: 5                     // +/- 5s expiry spread
})
```

### `cache.set<T>(key, value, options?): Promise<void>`

Writes to all layers simultaneously.

```ts
await cache.set('user:123', user, {
  ttl: { memory: 60, redis: 600 }, // per-layer TTL (seconds)
  tags: ['user', 'user:123'],
  staleWhileRevalidate: { redis: 30 },
  staleIfError: { redis: 120 },
  ttlJitter: { redis: 5 }
})

await cache.set('user:123', user, {
  ttl: 120, // uniform TTL across all layers
  tags: ['user', 'user:123']
})
```

## Invalidation & freshness

### `cache.invalidateByTag(tag): Promise<void>`

Deletes every key that was stored with this tag across all layers. In multi-instance deployments, this is only complete when every instance shares the same tag index implementation (for example `RedisTagIndex`).

```ts
await cache.set('user:123',       user,  { tags: ['user:123'] })
await cache.set('user:123:posts', posts, { tags: ['user:123'] })

await cache.invalidateByTag('user:123') // both keys gone
```

### `cache.invalidateByTags(tags, mode?): Promise<void>`

Delete keys that match any or all of a set of tags.

```ts
await cache.invalidateByTags(['tenant:a', 'users'], 'all') // keys tagged with both
await cache.invalidateByTags(['users', 'posts'], 'any')    // keys tagged with either
```

### `cache.invalidateByPattern(pattern): Promise<void>`

Glob-style deletion against the tracked key set, plus any layer that can enumerate real keys (for example `MemoryLayer`, `RedisLayer`, or `DiskLayer`).

```ts
await cache.invalidateByPattern('user:*') // deletes user:1, user:2, …
```

For multi-instance deployments, prefer a shared `RedisTagIndex`. Without it, pattern invalidation still scans real layer keys when available, but that fallback only helps on layers that implement `keys()`, and tag tracking itself remains process-local.

### `cache.invalidateByPrefix(prefix): Promise<void>`

Prefer this over glob invalidation when your keys are hierarchical.

```ts
await cache.invalidateByPrefix('user:123:') // deletes user:123:profile, user:123:posts, ...
```

The prefix is matched as-is. You do not need to append `*`, and namespace helpers pass their namespace prefix directly.

### `cache.mget<T>(entries): Promise<Array<T | null>>`

Concurrent multi-key fetch, each with its own optional fetcher.

If every entry is a simple read (`{ key }` only), `CacheStack` will use layer-level `getMany()` fast paths when the layer implements one.

```ts
const [user1, user2] = await cache.mget([
  { key: 'user:1', fetch: () => db.findUser(1) },
  { key: 'user:2', fetch: () => db.findUser(2) },
])
```

### `cache.getMetrics(): CacheMetricsSnapshot`

```ts
const { hits, misses, fetches, staleHits, refreshes, writeFailures } = cache.getMetrics()
```

### `cache.healthCheck(): Promise<CacheHealthCheckResult[]>`

```ts
const health = await cache.healthCheck()
// [{ layer: 'memory', healthy: true, latencyMs: 0.03 }, ...]
```

### `cache.resetMetrics(): void`

Resets all counters to zero — useful for per-interval reporting.

```ts
cache.resetMetrics()
```

### `cache.getStats(): CacheStatsSnapshot`

Returns metrics, per-layer degradation state, and the number of in-flight background refreshes.

```ts
const { metrics, layers, backgroundRefreshes } = cache.getStats()
// layers: [{ name, isLocal, degradedUntil }]
```

### `cache.wrap(prefix, fetcher, options?)`

Wraps an async function so every call is transparently cached. The key is derived from the function arguments unless you supply a `keyResolver`.

```ts
const getUser = cache.wrap('user', (id: number) => db.findUser(id))

const user = await getUser(123) // key → "user:123"

// Custom key resolver
const getUser = cache.wrap(
  'user',
  (id: number) => db.findUser(id),
  { keyResolver: (id) => String(id), ttl: 300 }
)
```

### Generation-based invalidation

Add a generation prefix to every key and rotate it when you want to invalidate the whole cache namespace without scanning:

```ts
const cache = new CacheStack([...], { generation: 1 })

await cache.set('user:123', user)
cache.bumpGeneration() // now reads use v2:user:123
```

If you also want old generation keys cleaned up automatically instead of waiting for TTL expiry:

```ts
const cache = new CacheStack([...], {
  generation: 1,
  generationCleanup: { batchSize: 500 }
})
```

`bumpGeneration()` only rotates future reads and writes by default. Enable `generationCleanup` when you want previous generations to be pruned automatically instead of aging out by TTL.

### OpenTelemetry note

`createOpenTelemetryPlugin()` currently wraps a `CacheStack` instance's methods directly. Use one OpenTelemetry plugin per cache instance; if you need to compose multiple wrappers, install them in a fixed order and uninstall them in reverse order.

### `cache.warm(entries, options?)`

Pre-populate layers at startup from a prioritised list. Higher `priority` values run first.

```ts
await cache.warm(
  [
    { key: 'config',     fetcher: () => db.getConfig(),     priority: 10 },
    { key: 'user:1',     fetcher: () => db.findUser(1),     priority: 5  },
    { key: 'user:2',     fetcher: () => db.findUser(2),     priority: 5  },
  ],
  { concurrency: 4, continueOnError: true }
)
```

### `cache.namespace(prefix): CacheNamespace`

Returns a scoped view with the same full API (`get`, `set`, `delete`, `clear`, `mget`, `wrap`, `warm`, `invalidateByTag`, `invalidateByPattern`, `getMetrics`). `clear()` only touches `prefix:*` keys, and namespace metrics are serialized per `CacheStack` instance so unrelated caches do not block each other while metrics are collected.

```ts
const users = cache.namespace('users')
const posts = cache.namespace('posts')

await users.set('123', userData)          // stored as "users:123"
await users.clear()                       // only deletes "users:*"

// Nested namespaces
const tenant = cache.namespace('tenant:abc')
const posts = tenant.namespace('posts')
await posts.set('1', postData)            // stored as "tenant:abc:posts:1"
```

### `cache.getOrThrow<T>(key, fetcher?, options?): Promise<T>`

Like `get()`, but throws `CacheMissError` instead of returning `null`. Useful when you know the value must exist (e.g. after a warm-up).

```ts
import { CacheMissError } from 'layercache'

try {
  const config = await cache.getOrThrow<Config>('app:config')
} catch (err) {
  if (err instanceof CacheMissError) {
    console.error(`Missing key: ${err.key}`)
  }
}
```

### `cache.inspect(key): Promise<CacheInspectResult | null>`

Returns detailed metadata about a cache key for debugging. Returns `null` if the key is not in any layer.

```ts
const info = await cache.inspect('user:123')
// {
//   key: 'user:123',
//   foundInLayers: ['memory', 'redis'],
//   freshTtlSeconds: 45,
//   staleTtlSeconds: 75,
//   errorTtlSeconds: 345,
//   isStale: false,
//   tags: ['user', 'user:123']
// }
```

### Conditional caching with `shouldCache`

Skip caching specific results without affecting the return value:

```ts
const data = await cache.get('api:response', fetchFromApi, {
  shouldCache: (value) => (value as any).status === 200
})
// If fetchFromApi returns { status: 500 }, the value is returned but NOT cached
```

### TTL policies

Align expirations to calendar or boundary-based schedules:

```ts
await cache.set('daily-report', report, { ttlPolicy: 'until-midnight' })
await cache.set('hourly-rollup', rollup, { ttlPolicy: 'next-hour' })
await cache.set('aligned', value, { ttlPolicy: { alignTo: 300 } }) // next 5-minute boundary
await cache.set('custom', value, {
  ttlPolicy: ({ key, value }) => key.startsWith('hot:') ? 30 : 300
})
```

---

## Negative + stale caching

`negativeCache` stores fetcher misses for a short TTL, which is useful for "user not found" or "feature flag absent" style lookups.

```ts
const user = await cache.get(`user:${id}`, () => db.findUser(id), {
  negativeCache: true,
  negativeTtl: 15
})
```

`staleWhileRevalidate` returns the last cached value immediately after expiry and refreshes it in the background. `staleIfError` keeps serving the stale value if the refresh fails.

```ts
await cache.set('config', currentConfig, {
  ttl: 60,
  staleWhileRevalidate: 30,
  staleIfError: 300
})
```

---

## Write failure policy

Default writes are strict: if any layer write fails, the operation throws.

If you prefer "at least one layer succeeds", enable best-effort mode:

```ts
const cache = new CacheStack([...], {
  writePolicy: 'best-effort'
})
```

`best-effort` logs the failed layers, increments `writeFailures`, and only throws if *every* layer failed.

---

## Cache stampede prevention

When 100 requests arrive simultaneously for an uncached key, only one fetcher runs. The rest wait and share the result.

```ts
const cache = new CacheStack([...])
// stampedePrevention is true by default

// 100 concurrent requests → fetcher executes exactly once
const results = await Promise.all(
  Array.from({ length: 100 }, () =>
    cache.get('hot-key', expensiveFetch)
  )
)
```

Disable it if you prefer independent fetches:

```ts
new CacheStack([...], { stampedePrevention: false })
```

---

## Distributed deployments

### Distributed single-flight

Local stampede prevention only deduplicates requests inside one Node.js process. To dedupe cross-instance misses, configure a shared coordinator.

```ts
import { RedisSingleFlightCoordinator } from 'layercache'

const coordinator = new RedisSingleFlightCoordinator({ client: redis })

const cache = new CacheStack(
  [new MemoryLayer({ ttl: 60 }), new RedisLayer({ client: redis, ttl: 300 })],
  {
    singleFlightCoordinator: coordinator,
    singleFlightLeaseMs: 30_000,
    singleFlightRenewIntervalMs: 10_000,
    singleFlightTimeoutMs: 5_000,
    singleFlightPollMs: 50
  }
)
```

When another instance already owns the miss, the current process waits for the value to appear in the shared layer instead of running the fetcher again. `RedisSingleFlightCoordinator` also renews its Redis lease while the worker is still running, so long fetches are less likely to expire their lock mid-flight. Keep `singleFlightLeaseMs` comfortably above your expected fetch latency, and use `singleFlightRenewIntervalMs` if you need tighter control over renewal cadence.

### Cross-server L1 invalidation

When one server writes or deletes a key, other servers' memory layers go stale. The `RedisInvalidationBus` propagates invalidation events over Redis pub/sub so every instance stays consistent.

```ts
import { RedisInvalidationBus } from 'layercache'

const publisher  = new Redis()
const subscriber = new Redis()
const bus = new RedisInvalidationBus({ publisher, subscriber })

const cache = new CacheStack(
  [new MemoryLayer({ ttl: 60 }), new RedisLayer({ client: publisher, ttl: 300 })],
  { invalidationBus: bus }
)

await cache.disconnect() // unsubscribes cleanly on shutdown
```

By default, write-triggered L1 invalidation is **off** even when an invalidation bus is configured. This avoids surprising Redis Pub/Sub traffic in write-heavy services. Enable it explicitly when you want every write to evict peer memory caches immediately:

```ts
new CacheStack([...], { invalidationBus: bus, broadcastL1Invalidation: true })
```

### Distributed tag invalidation

The default `TagIndex` lives in process memory — `invalidateByTag` on server A only knows about keys *that server A wrote*. For full cross-server tag invalidation, use `RedisTagIndex`:

```ts
import { RedisTagIndex } from 'layercache'

const sharedTagIndex = new RedisTagIndex({
  client: redis,
  prefix: 'myapp:tag-index', // namespaced so it doesn't collide with other data
  knownKeysShards: 8
})

// Every CacheStack instance should use the same Redis-backed tag index config
const cache = new CacheStack(
  [new MemoryLayer({ ttl: 60 }), new RedisLayer({ client: redis, ttl: 300 })],
  { invalidationBus: bus, tagIndex: sharedTagIndex }
)
```

Now `invalidateByTag('user:123')` on any server deletes every tagged key, regardless of which server originally wrote it.

The same recommendation applies to `invalidateByPattern()` and `invalidateByPrefix()` in distributed deployments: a shared tag index gives the most complete view of known keys, while layer key scans act as a fallback only when the shared layer exposes `keys()`.

### Safe Redis clearing

`RedisLayer.clear()` is intentionally conservative. Without a `prefix`, it throws instead of deleting the whole Redis database.

```ts
const cache = new CacheStack([
  new RedisLayer({
    client: redis,
    prefix: 'myapp:cache:' // recommended for safe clear() and key scans
  })
])
```

If you really want to clear an unprefixed namespace, you must opt in explicitly:

```ts
new RedisLayer({
  client: redis,
  allowUnprefixedClear: true
})
```

For production Redis, also set an explicit `prefix`, enforce Redis authentication/network isolation, and configure Redis `maxmemory` / eviction policy so cache growth cannot starve unrelated workloads.

### DiskLayer safety

`DiskLayer` is best used with an application-controlled directory and an explicit `maxFiles` bound.

```ts
import { resolve } from 'node:path'

const disk = new DiskLayer({
  directory: resolve('./var/cache/layercache'),
  maxFiles: 10_000
})
```

The library hashes cache keys before turning them into filenames, validates the configured directory, uses atomic temp-file writes, and removes malformed on-disk entries. You should still keep the directory outside any user-controlled path and set filesystem permissions so only your app can read or write it.

### Scoped fetcher rate limiting

Rate limits are global by default, but you can scope them per cache key or per fetcher function when different backends should not throttle each other.

```ts
await cache.get('user:123', fetchUser, {
  fetcherRateLimit: {
    maxConcurrent: 1,
    scope: 'key'
  }
})
```

Use `scope: 'fetcher'` to share a bucket across calls using the same fetcher function reference, or `bucketKey: 'billing-api'` for a custom named bucket.

---

## Per-layer TTL overrides

Layer names match the `name` option on each layer (`'memory'` and `'redis'` by default).

```ts
await cache.set('session:abc', sessionData, {
  ttl: { memory: 30, redis: 3600 } // 30s in RAM, 1h in Redis
})

// Same override works on get (applied to backfills)
await cache.get('session:abc', fetchSession, {
  ttl: { memory: 30, redis: 3600 }
})
```

Custom layer names:

```ts
new MemoryLayer({ name: 'local', ttl: 60 })
new RedisLayer({ name: 'shared', client: redis, ttl: 300 })

// then
await cache.set('key', value, { ttl: { local: 15, shared: 600 } })
```

---

## Sliding & adaptive TTL

**Sliding TTL** resets the TTL on every read so frequently-accessed keys never expire.

```ts
const value = await cache.get('session:abc', fetchSession, { slidingTtl: true })
```

**Adaptive TTL** automatically increases the TTL of hot keys up to a ceiling.

```ts
await cache.get('popular-post', fetchPost, {
  adaptiveTtl: {
    hotAfter: 5,      // ramp up after 5 hits
    step: 60,         // add 60s per hit
    maxTtl: 3600      // cap at 1h
  }
})
```

**Refresh-ahead** triggers a background refresh when the remaining TTL drops below a threshold, so callers never see a miss.

```ts
await cache.get('leaderboard', fetchLeaderboard, {
  ttl: 120,
  refreshAhead: 30  // start refreshing when ≤30s remain
})
```

Background refreshes time out after 30 seconds by default so a hung upstream fetch cannot block future refresh attempts forever. Override that with `backgroundRefreshTimeoutMs`.

---

## Graceful degradation & circuit breaker

**Graceful degradation** marks a layer as degraded on failure and skips it for a retry window, keeping the cache available even if Redis is briefly unreachable.

```ts
new CacheStack([...], {
  gracefulDegradation: { retryAfterMs: 10_000 }
})
```

**Circuit breaker** opens after repeated fetcher failures for a key, returning `null` instead of hammering a broken downstream.

```ts
new CacheStack([...], {
  circuitBreaker: {
    failureThreshold: 5,  // open after 5 consecutive failures
    cooldownMs: 30_000    // retry after 30s
  }
})

// Or per-operation
await cache.get('fragile-key', fetch, {
  circuitBreaker: { failureThreshold: 3, cooldownMs: 10_000 }
})
```

---

## Compression

`RedisLayer` can transparently compress values before writing. Values smaller than `compressionThreshold` are stored as-is.

```ts
new RedisLayer({
  client: redis,
  ttl: 300,
  compression: 'gzip',           // or 'brotli'
  compressionThreshold: 1_024    // bytes — skip compression for small values
})
```

---

## Stats & HTTP endpoint

`cache.getStats()` returns a full snapshot suitable for dashboards or health checks.

```ts
const stats = cache.getStats()
// {
//   metrics: { hits, misses, fetches, circuitBreakerTrips, ... },
//   layers:  [{ name, isLocal, degradedUntil }],
//   backgroundRefreshes: 2
// }
```

Mount a JSON endpoint with the built-in HTTP handler (works with Express, Fastify, Next.js):

```ts
import { createCacheStatsHandler } from 'layercache'
import http from 'node:http'

const statsHandler = createCacheStatsHandler(cache)
http.createServer(statsHandler).listen(9090)
// GET / → JSON stats
```

Or use the Fastify plugin:

```ts
import { createFastifyLayercachePlugin } from 'layercache/integrations/fastify'

await fastify.register(createFastifyLayercachePlugin(cache, {
  statsPath: '/cache/stats'   // default; set exposeStatsRoute: false to disable
}))
// fastify.cache is now available in all handlers
```

---

## Persistence & snapshots

Transfer cache state between `CacheStack` instances or survive a restart.

```ts
// In-memory snapshot
const snapshot = await cache.exportState()
await anotherCache.importState(snapshot)

// Disk snapshot
await cache.persistToFile('./cache-snapshot.json')
await cache.restoreFromFile('./cache-snapshot.json')
```

For safety, file snapshots are restricted to `process.cwd()` by default. Set `snapshotBaseDir` to an explicit directory for application-controlled snapshot storage, or `false` if you intentionally want to disable that restriction.

---

## Event hooks

`CacheStack` extends `EventEmitter`. Subscribe to events for monitoring or custom side-effects.

| Event | Payload |
|-------|---------|
| `hit` | `{ key, layer }` |
| `miss` | `{ key }` |
| `set` | `{ key }` |
| `delete` | `{ key }` |
| `stale-serve` | `{ key, state, layer }` |
| `stampede-dedupe` | `{ key }` |
| `backfill` | `{ key, fromLayer, toLayer }` |
| `warm` | `{ key }` |
| `error` | `{ event, context }` |

```ts
cache.on('hit',   ({ key, layer }) => metrics.inc('cache.hit',  { layer }))
cache.on('miss',  ({ key })        => metrics.inc('cache.miss'))
cache.on('error', ({ event, context }) => logger.error(event, context))
```

---

## Integrations & tooling

### Framework integrations

#### Express

```ts
import { CacheStack, MemoryLayer, createExpressCacheMiddleware } from 'layercache'

const cache = new CacheStack([new MemoryLayer({ ttl: 60 })])

// Automatically caches GET responses as JSON
app.get('/api/users', createExpressCacheMiddleware(cache, { ttl: 30 }), (req, res) => {
  res.json(await db.getUsers())
})

// Custom key resolver + tag support
app.get('/api/user/:id', createExpressCacheMiddleware(cache, {
  keyResolver: (req) => `user:${req.url}`,
  tags: ['users'],
  ttl: 60
}), handler)
```

#### tRPC

```ts
import { createTrpcCacheMiddleware } from 'layercache/integrations/trpc'

const cacheMiddleware = createTrpcCacheMiddleware(cache, 'trpc', { ttl: 60 })

export const cachedProcedure = t.procedure.use(cacheMiddleware)
```

#### GraphQL

```ts
import { cacheGraphqlResolver } from 'layercache/integrations/graphql'

const resolvers = {
  Query: {
    user: cacheGraphqlResolver(cache, 'user', (_root, { id }) => db.findUser(id), {
      keyResolver: (_root, { id }) => id,
      ttl: 300
    })
  }
}
```

---

### Admin CLI

Inspect and manage a Redis-backed cache without writing code.

```bash
# Requires ioredis
npx layercache stats     --redis redis://localhost:6379
npx layercache keys      --redis redis://localhost:6379 --pattern "user:*"
npx layercache invalidate --redis redis://localhost:6379 --tag user:123
npx layercache invalidate --redis redis://localhost:6379 --pattern "session:*"
```

---

## MessagePack serialization

Reduces Redis memory usage and speeds up serialization for large values:

```ts
import { MsgpackSerializer } from 'layercache'

new RedisLayer({
  client: redis,
  ttl: 300,
  serializer: new MsgpackSerializer()
})
```

---

## Custom layers

Implement `CacheLayer` to plug in any backend:

```ts
import type { CacheLayer } from 'layercache'

class MemcachedLayer implements CacheLayer {
  readonly name = 'memcached'
  readonly defaultTtl = 300
  readonly isLocal = false

  async get<T>(key: string): Promise<T | null> { /* … */ }
  async getEntry?(key: string): Promise<unknown | null> { /* optional raw access */ }
  async getMany?(keys: string[]): Promise<Array<unknown | null>> { /* optional bulk read */ }
  async set(key: string, value: unknown, ttl?: number): Promise<void> { /* … */ }
  async delete(key: string): Promise<void> { /* … */ }
  async clear(): Promise<void> { /* … */ }
}

const cache = new CacheStack([
  new MemoryLayer({ ttl: 60 }),
  new MemcachedLayer()
])
```

---

## NestJS

```bash
npm install @cachestack/nestjs
```

```ts
// app.module.ts
import { CacheStackModule } from '@cachestack/nestjs'

@Module({
  imports: [
    CacheStackModule.forRoot({
      layers: [
        new MemoryLayer({ ttl: 20 }),
        new RedisLayer({ client: redis, ttl: 300 })
      ]
    })
  ]
})
export class AppModule {}
```

Async configuration (resolve dependencies from DI):

```ts
@Module({
  imports: [
    CacheStackModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        layers: [
          new MemoryLayer({ ttl: 20 }),
          new RedisLayer({ client: new Redis(config.get('REDIS_URL')), ttl: 300 })
        ]
      })
    })
  ]
})
export class AppModule {}
```

```ts
// your.service.ts
import { InjectCacheStack } from '@cachestack/nestjs'
import { CacheStack } from 'layercache'

@Injectable()
export class UserService {
  constructor(@InjectCacheStack() private readonly cache: CacheStack) {}

  async getUser(id: number) {
    return this.cache.get(`user:${id}`, () => this.db.findUser(id))
  }
}
```

---

## Express / Next.js

```ts
// Express
app.get('/users/:id', async (req, res) => {
  const user = await cache.get(`user:${req.params.id}`,
    () => db.findUser(Number(req.params.id)),
    { tags: [`user:${req.params.id}`] }
  )
  res.json(user)
})

// Next.js App Router
export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const data = await cache.get(`user:${params.id}`, () => db.findUser(Number(params.id)))
  return Response.json(data)
}
```

---

## Environment-based configuration

```ts
export const cache = process.env.NODE_ENV === 'production'
  ? new CacheStack([
      new MemoryLayer({ ttl: 60 }),
      new RedisLayer({ client: redis, ttl: 3600 })
    ])
  : new CacheStack([
      new MemoryLayer({ ttl: 60 }) // no Redis needed in dev
    ])
```

---

## Benchmarks

```bash
npm run bench:latency
npm run bench:stampede
```

These scripts use `ioredis-mock` and a synthetic no-cache delay, so treat the numbers as a quick sanity check rather than a production benchmark.

Example output from a local run:

| | avg latency |
|---|---|
| L1 memory hit | ~0.006 ms |
| L2 Redis hit | ~0.020 ms |
| No cache (simulated DB) | ~1.08 ms |

```
┌─────────────────────┬────────┐
│ concurrentRequests  │  100   │
│ fetcherExecutions   │    1   │  ← stampede prevention in action
└─────────────────────┴────────┘
```

---

## Comparison

| | node-cache-manager | keyv | cacheable | **layercache** |
|---|:---:|:---:|:---:|:---:|
| Multi-layer | △ | Plugin | ❌ | ✅ |
| Auto backfill | ❌ | ❌ | ❌ | ✅ |
| Stampede prevention | ❌ | ❌ | ❌ | ✅ |
| Tag invalidation | ❌ | ❌ | ✅ | ✅ |
| Distributed tags | ❌ | ❌ | ❌ | ✅ |
| Cross-server L1 flush | ❌ | ❌ | ❌ | ✅ |
| TypeScript-first | △ | ✅ | ✅ | ✅ |
| Wrap / decorator API | ✅ | ❌ | ❌ | ✅ |
| Cache warming | ❌ | ❌ | ❌ | ✅ |
| Namespaces | ❌ | ✅ | ✅ | ✅ |
| Sliding / adaptive TTL | ❌ | ❌ | ❌ | ✅ |
| Event hooks | ✅ | ✅ | ✅ | ✅ |
| Circuit breaker | ❌ | ❌ | ❌ | ✅ |
| Graceful degradation | ❌ | ❌ | ❌ | ✅ |
| Compression | ❌ | ❌ | ✅ | ✅ |
| Persistence / snapshots | ❌ | ❌ | ❌ | ✅ |
| Admin CLI | ❌ | ❌ | ❌ | ✅ |
| Pluggable logger | ❌ | ❌ | ✅ | ✅ |
| NestJS module | ❌ | ❌ | ❌ | ✅ |
| Custom layers | △ | ❌ | ❌ | ✅ |

---

## Debug logging

```bash
DEBUG=layercache:debug node server.js
```

Or pass a logger instance:

```ts
new CacheStack([...], {
  logger: {
    debug(message, context) { myLogger.debug(message, context) }
  }
})
```

---

## Requirements

- Node.js ≥ 20
- TypeScript ≥ 5.0 (optional — fully typed, ships `.d.ts`)
- ioredis ≥ 5 (optional peer dependency — only needed for `RedisLayer` / `RedisTagIndex`)

---

## Contributing

Contributions are welcome, whether that means bug fixes, documentation improvements, performance work, new adapters, or issue reports.

```bash
git clone https://github.com/flyingsquirrel0419/layercache
cd layercache
npm install
npm run lint
npm test          # vitest
npm run build:all # esm + cjs + nestjs package
```

- Read the [contribution guide](./CONTRIBUTING.md) before opening a PR.
- Participation in the project is covered by the [Code of Conduct](./CODE_OF_CONDUCT.md).
- If you are filing an issue, include reproduction steps, expected behavior, and runtime details when relevant.

---

## License

MIT
