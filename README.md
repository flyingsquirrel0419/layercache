# cache-bridge

**Multi-layer caching for Node.js — memory → Redis → your DB, unified in one API.**

[![npm version](https://img.shields.io/npm/v/cache-bridge)](https://www.npmjs.com/package/cache-bridge)
[![npm downloads](https://img.shields.io/npm/dw/cache-bridge)](https://www.npmjs.com/package/cache-bridge)
[![license](https://img.shields.io/npm/l/cache-bridge)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-first-blue)](https://www.typescriptlang.org/)

```
L1 hit  ~0.01 ms  ← served from memory, zero network
L2 hit  ~0.5  ms  ← served from Redis, backfilled to memory
miss    ~20   ms  ← fetcher runs once, all layers filled
```

---

## Why cache-bridge?

Most Node.js services end up with the same problem:

- **Memory-only** → fast, but not shared across servers
- **Redis-only** → shared, but every read pays a network round-trip
- **Hand-rolled layers** → works, but you rewrite stampede prevention, backfill logic, and tag invalidation in every project

cache-bridge solves all three. You declare your layers once and call `get`. Everything else is handled.

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
- **Distributed tag index** — `RedisTagIndex` keeps tag state consistent across multiple servers
- **Cross-server L1 invalidation** — Redis pub/sub bus flushes stale memory on other instances when you write or delete
- **Metrics** — hit/miss/fetch/backfill counters built in
- **MessagePack serializer** — drop-in replacement for lower Redis memory usage
- **NestJS module** — `CacheBridgeModule.forRoot(...)` with `@InjectCacheBridge()`
- **Custom layers** — implement the 5-method `CacheLayer` interface to plug in Memcached, DynamoDB, or anything else
- **ESM + CJS** — works with both module systems, Node.js ≥ 18

---

## Installation

```bash
npm install cache-bridge
# Redis support (optional)
npm install ioredis
```

---

## Quick start

```ts
import { CacheBridge, MemoryLayer, RedisLayer } from 'cache-bridge'
import Redis from 'ioredis'

const cache = new CacheBridge([
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
const cache = new CacheBridge([
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
  tags: ['user', 'user:123']       // tag this key for bulk invalidation
})
```

### `cache.set<T>(key, value, options?): Promise<void>`

Writes to all layers simultaneously.

```ts
await cache.set('user:123', user, {
  ttl: { memory: 60, redis: 600 }, // per-layer TTL (seconds)
  tags: ['user', 'user:123']
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

```ts
const [user1, user2] = await cache.mget([
  { key: 'user:1', fetch: () => db.findUser(1) },
  { key: 'user:2', fetch: () => db.findUser(2) },
])
```

### `cache.getMetrics(): CacheMetricsSnapshot`

```ts
const { hits, misses, fetches, backfills } = cache.getMetrics()
```

---

## Cache stampede prevention

When 100 requests arrive simultaneously for an uncached key, only one fetcher runs. The rest wait and share the result.

```ts
const cache = new CacheBridge([...])
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
new CacheBridge([...], { stampedePrevention: false })
```

---

## Distributed deployments

### Cross-server L1 invalidation

When one server writes or deletes a key, other servers' memory layers go stale. The `RedisInvalidationBus` propagates invalidation events over Redis pub/sub so every instance stays consistent.

```ts
import { RedisInvalidationBus } from 'cache-bridge'

const publisher  = new Redis()
const subscriber = new Redis()
const bus = new RedisInvalidationBus({ publisher, subscriber })

const cache = new CacheBridge(
  [new MemoryLayer({ ttl: 60 }), new RedisLayer({ client: publisher, ttl: 300 })],
  { invalidationBus: bus }
)

await cache.disconnect() // unsubscribes cleanly on shutdown
```

By default, every `set` also broadcasts an invalidation so other servers evict stale memory immediately. To suppress broadcasts on writes (high write-volume services):

```ts
new CacheBridge([...], { invalidationBus: bus, publishSetInvalidation: false })
```

### Distributed tag invalidation

The default `TagIndex` lives in process memory — `invalidateByTag` on server A only knows about keys *that server A wrote*. For full cross-server tag invalidation, use `RedisTagIndex`:

```ts
import { RedisTagIndex } from 'cache-bridge'

const sharedTagIndex = new RedisTagIndex({
  client: redis,
  prefix: 'myapp:tag-index' // namespaced so it doesn't collide with other data
})

// Every CacheBridge instance should use the same Redis-backed tag index config
const cache = new CacheBridge(
  [new MemoryLayer({ ttl: 60 }), new RedisLayer({ client: redis, ttl: 300 })],
  { invalidationBus: bus, tagIndex: sharedTagIndex }
)
```

Now `invalidateByTag('user:123')` on any server deletes every tagged key, regardless of which server originally wrote it.

### Safe Redis clearing

`RedisLayer.clear()` is intentionally conservative. Without a `prefix`, it throws instead of deleting the whole Redis database.

```ts
const cache = new CacheBridge([
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

## MessagePack serialization

Reduces Redis memory usage and speeds up serialization for large values:

```ts
import { MsgpackSerializer } from 'cache-bridge'

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
import type { CacheLayer } from 'cache-bridge'

class MemcachedLayer implements CacheLayer {
  readonly name = 'memcached'
  readonly defaultTtl = 300
  readonly isLocal = false

  async get<T>(key: string): Promise<T | null> { /* … */ }
  async set(key: string, value: unknown, ttl?: number): Promise<void> { /* … */ }
  async delete(key: string): Promise<void> { /* … */ }
  async clear(): Promise<void> { /* … */ }
}

const cache = new CacheBridge([
  new MemoryLayer({ ttl: 60 }),
  new MemcachedLayer()
])
```

---

## NestJS

```bash
npm install @cache-bridge/nestjs
```

```ts
// app.module.ts
import { CacheBridgeModule } from '@cache-bridge/nestjs'

@Module({
  imports: [
    CacheBridgeModule.forRoot({
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
import { InjectCacheBridge } from '@cache-bridge/nestjs'
import { CacheBridge } from 'cache-bridge'

@Injectable()
export class UserService {
  constructor(@InjectCacheBridge() private readonly cache: CacheBridge) {}

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
  ? new CacheBridge([
      new MemoryLayer({ ttl: 60 }),
      new RedisLayer({ client: redis, ttl: 3600 })
    ])
  : new CacheBridge([
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

| | node-cache | ioredis | cache-manager | **cache-bridge** |
|---|:---:|:---:|:---:|:---:|
| Multi-layer | ❌ | ❌ | △ | ✅ |
| Auto backfill | ❌ | ❌ | ❌ | ✅ |
| Stampede prevention | ❌ | ❌ | ❌ | ✅ |
| Tag invalidation | ❌ | ❌ | ❌ | ✅ |
| Distributed tags | ❌ | ❌ | ❌ | ✅ |
| Cross-server L1 flush | ❌ | ❌ | ❌ | ✅ |
| TypeScript-first | ❌ | ✅ | △ | ✅ |
| NestJS module | ❌ | ❌ | ✅ | ✅ |
| Custom layers | ❌ | — | △ | ✅ |

---

## Debug logging

```bash
DEBUG=cache-bridge:debug node server.js
```

Or pass a logger instance:

```ts
new CacheBridge([...], {
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
git clone https://github.com/flyingsquirrel0419/cache-bridge
cd cache-bridge
npm install
npm test          # vitest
npm run build:all # esm + cjs + nestjs package
```

PRs and issues welcome.

---

## License

MIT
