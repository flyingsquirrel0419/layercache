# layercache

**Multi-layer caching for Node.js — memory → Redis → your DB, unified in one API.**

[![npm version](https://img.shields.io/npm/v/layercache)](https://www.npmjs.com/package/layercache)
[![npm downloads](https://img.shields.io/npm/dw/layercache)](https://www.npmjs.com/package/layercache)
[![license](https://img.shields.io/npm/l/layercache)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-first-blue)](https://www.typescriptlang.org/)
[![test coverage](https://img.shields.io/badge/tests-49%20passing-brightgreen)](https://github.com/flyingsquirrel0419/layercache)

```
L1 hit  ~0.01 ms  ← served from memory, zero network
L2 hit  ~0.5  ms  ← served from Redis, backfilled to memory
miss    ~20   ms  ← fetcher runs once, all layers filled
```

---

## Why layercache?

Most Node.js services end up with the same problem:

- **Memory-only** → fast, but not shared across servers
- **Redis-only** → shared, but every read pays a network round-trip
- **Hand-rolled layers** → works, but you rewrite stampede prevention, backfill logic, and tag invalidation in every project

layercache solves all three. You declare your layers once and call `get`. Everything else is handled.

```ts
const user = await cache.get('user:123', () => db.findUser(123))
//                                         ↑ only called on a full miss
```

On a hit, the value is returned from the fastest layer that has it, and automatically backfilled into any faster layers that didn't. On a miss, the fetcher runs exactly once — even under 100 concurrent requests for the same key.

---

## Features

- **Layered reads & automatic backfill** — hits in slower layers propagate up
- **Cache stampede prevention** — mutex-based deduplication per key
- **Tag-based invalidation** — `set('user:123:posts', posts, { tags: ['user:123'] })` then `invalidateByTag('user:123')`
- **Pattern invalidation** — `invalidateByPattern('user:*')`
- **Per-layer TTL overrides** — different TTLs for memory vs. Redis in one call
- **Negative caching** — cache known misses for a short TTL to protect the database
- **Stale strategies** — `staleWhileRevalidate` and `staleIfError` as opt-in read behavior
- **TTL jitter** — spread expirations to avoid synchronized stampedes
- **Sliding & adaptive TTL** — extend TTL on every read or ramp it up for hot keys
- **Refresh-ahead** — trigger background refresh when TTL drops below a threshold
- **Best-effort writes** — tolerate partial layer write failures when desired
- **Bulk reads** — `mget` uses layer-level `getMany()` when available
- **Distributed tag index** — `RedisTagIndex` keeps tag state consistent across multiple servers
- **Optional distributed single-flight** — plug in a coordinator to dedupe misses across instances
- **Cross-server L1 invalidation** — Redis pub/sub bus flushes stale memory on other instances when you write or delete
- **`wrap()` decorator API** — turn any async function into a cached version with auto-generated keys
- **Cache warming** — pre-populate layers with a prioritised list of entries at startup
- **Namespaces** — scope a `CacheStack` to a key prefix for multi-tenant or module isolation
- **Event hooks** — `EventEmitter`-based events for hits, misses, stale serves, errors, and more
- **Graceful degradation** — skip a failing layer for a configurable retry window
- **Circuit breaker** — per-key or global; opens after N failures, recovers after cooldown
- **Compression** — transparent gzip/brotli in `RedisLayer` with a byte threshold
- **Metrics & stats** — per-layer hit/miss counters, circuit-breaker trips, degraded operations; HTTP stats handler
- **Persistence** — `exportState` / `importState` for in-process snapshots; `persistToFile` / `restoreFromFile` for disk
- **Admin CLI** — `layercache stats | keys | invalidate` against any Redis URL
- **Framework integrations** — Fastify plugin, tRPC middleware, GraphQL resolver wrapper
- **MessagePack serializer** — drop-in replacement for lower Redis memory usage
- **NestJS module** — `CacheStackModule.forRoot(...)` with `@InjectCacheStack()`
- **Custom layers** — implement the 5-method `CacheLayer` interface to plug in Memcached, DynamoDB, or anything else
- **ESM + CJS** — works with both module systems, Node.js ≥ 18

---

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

### `cache.invalidateByTag(tag): Promise<void>`

Deletes every key that was stored with this tag across all layers.

```ts
await cache.set('user:123',       user,  { tags: ['user:123'] })
await cache.set('user:123:posts', posts, { tags: ['user:123'] })

await cache.invalidateByTag('user:123') // both keys gone
```

### `cache.invalidateByPattern(pattern): Promise<void>`

Glob-style deletion against the tracked key set.

```ts
await cache.invalidateByPattern('user:*') // deletes user:1, user:2, …
```

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

Returns a scoped view with the same full API (`get`, `set`, `delete`, `clear`, `mget`, `wrap`, `warm`, `invalidateByTag`, `invalidateByPattern`, `getMetrics`). `clear()` only touches `prefix:*` keys.

```ts
const users = cache.namespace('users')
const posts = cache.namespace('posts')

await users.set('123', userData)          // stored as "users:123"
await users.clear()                       // only deletes "users:*"
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
    singleFlightTimeoutMs: 5_000,
    singleFlightPollMs: 50
  }
)
```

When another instance already owns the miss, the current process waits for the value to appear in the shared layer instead of running the fetcher again.

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

By default, every `set` also broadcasts an invalidation so other servers evict stale memory immediately. To suppress broadcasts on writes (high write-volume services):

```ts
new CacheStack([...], { invalidationBus: bus, publishSetInvalidation: false })
```

### Distributed tag invalidation

The default `TagIndex` lives in process memory — `invalidateByTag` on server A only knows about keys *that server A wrote*. For full cross-server tag invalidation, use `RedisTagIndex`:

```ts
import { RedisTagIndex } from 'layercache'

const sharedTagIndex = new RedisTagIndex({
  client: redis,
  prefix: 'myapp:tag-index' // namespaced so it doesn't collide with other data
})

// Every CacheStack instance should use the same Redis-backed tag index config
const cache = new CacheStack(
  [new MemoryLayer({ ttl: 60 }), new RedisLayer({ client: redis, ttl: 300 })],
  { invalidationBus: bus, tagIndex: sharedTagIndex }
)
```

Now `invalidateByTag('user:123')` on any server deletes every tagged key, regardless of which server originally wrote it.

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

## Framework integrations

### tRPC

```ts
import { createTrpcCacheMiddleware } from 'layercache/integrations/trpc'

const cacheMiddleware = createTrpcCacheMiddleware(cache, 'trpc', { ttl: 60 })

export const cachedProcedure = t.procedure.use(cacheMiddleware)
```

### GraphQL

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

## Admin CLI

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

- Node.js ≥ 18
- TypeScript ≥ 5.0 (optional — fully typed, ships `.d.ts`)
- ioredis ≥ 5 (optional peer dependency — only needed for `RedisLayer` / `RedisTagIndex`)

---

## Contributing

```bash
git clone https://github.com/flyingsquirrel0419/layercache
cd layercache
npm install
npm test          # vitest
npm run build:all # esm + cjs + nestjs package
```

PRs and issues welcome.

---

## License

MIT
