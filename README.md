<p align="center">
  <strong>English</strong> | <a href="./docs/i18n/README.ko.md">한국어</a> | <a href="./docs/i18n/README.zh-CN.md">简体中文</a> | <a href="./docs/i18n/README.ja.md">日本語</a> | <a href="./docs/i18n/README.es.md">Español</a>
</p>

<p align="center">
  <img src="./logo.png" width="520" alt="layercache logo">
</p>

<h1 align="center">layercache</h1>

<p align="center">
  <strong>100 concurrent requests. 1 DB call. Always.</strong><br>
  <em>Multi-layer cache (Memory → Redis → Disk) with stampede prevention built in.</em>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/layercache"><img src="https://img.shields.io/npm/v/layercache?color=cb3837&label=npm" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/layercache"><img src="https://img.shields.io/npm/dw/layercache?color=blue" alt="npm downloads"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-Apache_2.0-green" alt="license"></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-first-3178C6?logo=typescript&logoColor=white" alt="TypeScript"></a>
  <img src="https://img.shields.io/badge/Node.js-%E2%89%A5_20-339933?logo=nodedotjs&logoColor=white" alt="Node.js >= 20">
  <img src="https://img.shields.io/badge/tests-467_passing-brightgreen" alt="tests">
  <a href="https://coveralls.io/github/flyingsquirrel0419/layercache?branch=main"><img src="https://coveralls.io/repos/github/flyingsquirrel0419/layercache/badge.svg?branch=main&t=20260410" alt="Coveralls"></a>
</p>

<p align="center">
  <a href="https://layercache.flyingsquirrel.me">Website</a>&nbsp;&nbsp;|&nbsp;&nbsp;
  <a href="#-quick-start">Quick Start</a>&nbsp;&nbsp;|&nbsp;&nbsp;
  <a href="#-performance">Performance</a>&nbsp;&nbsp;|&nbsp;&nbsp;
  <a href="./docs/api.md">API Reference</a>&nbsp;&nbsp;|&nbsp;&nbsp;
  <a href="#-integrations">Integrations</a>&nbsp;&nbsp;|&nbsp;&nbsp;
  <a href="#-comparison">Comparison</a>&nbsp;&nbsp;|&nbsp;&nbsp;
  <a href="./docs/tutorial.md">Tutorial</a>&nbsp;&nbsp;|&nbsp;&nbsp;
  <a href="./docs/migration-guide.md">Migration Guide</a>
</p>

---

## Why layercache?

```ts
// 100 concurrent requests hit an empty cache at the same time.
// Without stampede prevention, your DB gets 100 calls.
const results = await Promise.all(
  Array.from({ length: 100 }, () =>
    cache.get('user:1', () => db.findUser(1))
  )
)
// fetcherExecutions: 1  ← your DB was called exactly once
```

layercache is a multi-layer cache (Memory → Redis → Disk) for Node.js. Stampede prevention, tag invalidation, and distributed consistency are built in — no extra config required.

---

## Quick Start

```bash
npm install layercache
```

```ts
import { CacheStack, MemoryLayer, RedisLayer } from 'layercache'
import Redis from 'ioredis'

const cache = new CacheStack([
  new MemoryLayer({ ttl: 60, maxSize: 1_000 }),       // L1: in-process
  new RedisLayer({ client: new Redis(), ttl: 3600 }),  // L2: shared
])

// Read-through: fetcher runs once, all layers filled
const user = await cache.get('user:123', () => db.findUser(123))
```

<details>
<summary><b>Memory-only (no Redis required)</b></summary>

```ts
const cache = new CacheStack([
  new MemoryLayer({ ttl: 60 })
])
```

</details>

<details>
<summary><b>Three-layer setup with disk persistence</b></summary>

```ts
import { CacheStack, MemoryLayer, RedisLayer, DiskLayer } from 'layercache'

const cache = new CacheStack([
  new MemoryLayer({ ttl: 60, maxSize: 5_000 }),
  new RedisLayer({ client: new Redis(), ttl: 3600, compression: 'gzip' }),
  new DiskLayer({ directory: './var/cache', maxFiles: 10_000 }),
])
```

</details>

---

## Performance

```
Environment: Node.js v20.20.1, Redis 7-alpine, Linux x86_64
CPU: AMD EPYC 4584PX 16-Core  |  RAM: 1.9 GB
Layers: MemoryLayer(ttl=60, maxSize=2000) + RedisLayer(ttl=300)
```

```
┌──────────────────────────────┬──────────┬──────────┬──────────┬──────────┐
│ Scenario                     │  avg ms  │  p95 ms  │  min ms  │  max ms  │
├──────────────────────────────┼──────────┼──────────┼──────────┼──────────┤
│ L1 memory hit (warm)         │   0.011  │   0.016  │   0.004  │   0.405  │
│ L1 hit in layered setup      │   0.006  │   0.007  │   0.004  │   0.077  │
│ No cache / origin fetch      │   6.844  │  11.196  │   4.683  │  11.196  │
└──────────────────────────────┴──────────┴──────────┴──────────┴──────────┘

┌──────────────────────────────┬────────────────────┐
│                              │  75 concurrent req  │
├──────────────────────────────┼────────────────────┤
│ Without layercache           │  75 origin calls   │
│ With layercache              │   1 origin call    │  ← stampede prevention
└──────────────────────────────┴────────────────────┘
```

Benchmark commands and full scenario notes: [docs/benchmarking.md](./docs/benchmarking.md)

---

## Migrating from node-cache-manager?

<table>
<tr>
<th>Before</th>
<th>After</th>
</tr>
<tr>
<td>

```ts
import { caching, multiCaching }
  from 'cache-manager'
import { redisStore }
  from 'cache-manager-redis-yet'

const mem = await caching('memory', {
  max: 100,
  ttl: 60 * 1000        // ms
})
const red = await caching(redisStore, {
  url: 'redis://localhost:6379',
  ttl: 300 * 1000       // ms
})
const cache = multiCaching([mem, red])

// stampede prevention:  ❌
// auto backfill:        ❌
// tag invalidation:     ❌
```

</td>
<td>

```ts
import {
  CacheStack,
  MemoryLayer,
  RedisLayer
} from 'layercache'
import Redis from 'ioredis'

const cache = new CacheStack([
  new MemoryLayer({ ttl: 60 }),    // s
  new RedisLayer({
    client: new Redis(),
    ttl: 300                       // s
  })
])

// stampede prevention:  ✅
// auto backfill:        ✅
// tag invalidation:     ✅
```

</td>
</tr>
</table>

> Full migration guides for [keyv and cacheable](./docs/migration-guide.md).

---

## Comparison

|  | node-cache-manager | keyv | cacheable | **layercache** |
|---|:---:|:---:|:---:|:---:|
| Multi-layer + auto backfill | Partial | Plugin | -- | **Yes** |
| Stampede prevention | -- | -- | -- | **Yes** |
| Tag invalidation | -- | Yes | Yes | **Yes** |
| TypeScript-first | Partial | Yes | Yes | **Yes** |
| Event hooks | Yes | Yes | Yes | **Yes** |

<details>
<summary>Full comparison (19 features)</summary>

|  | node-cache-manager | keyv | cacheable | **layercache** |
|---|:---:|:---:|:---:|:---:|
| Multi-layer with auto backfill | Partial | Plugin | -- | **Yes** |
| Stampede prevention | -- | -- | -- | **Yes** |
| Distributed single-flight | -- | -- | -- | **Yes** |
| Tag invalidation | -- | Yes | Yes | **Yes** |
| Distributed tags | -- | -- | -- | **Yes** |
| Cross-server L1 flush | -- | -- | -- | **Yes** |
| Stale-while-revalidate | -- | -- | -- | **Yes** |
| Circuit breaker | -- | -- | -- | **Yes** |
| Graceful degradation | -- | -- | -- | **Yes** |
| Sliding / adaptive TTL | -- | -- | -- | **Yes** |
| Cache warming | -- | -- | -- | **Yes** |
| Persistence / snapshots | -- | -- | -- | **Yes** |
| Compression | -- | -- | Yes | **Yes** |
| Admin CLI | -- | -- | -- | **Yes** |
| TypeScript-first | Partial | Yes | Yes | **Yes** |
| Wrap / decorator API | Yes | -- | -- | **Yes** |
| Namespaces | -- | Yes | Yes | **Yes** |
| Event hooks | Yes | Yes | Yes | **Yes** |
| Custom layers | Partial | -- | -- | **Yes** |

</details>

> See the full [comparison guide](./docs/comparison.md) for detailed breakdowns.

---

## Features

<details>
<summary><b>Core Caching, Invalidation, Resilience & Observability (click to expand)</b></summary>

### Core Caching

| Feature | What it does |
|---|---|
| **Layered reads + auto backfill** | Reads hit L1 first; on a partial hit, upper layers are filled automatically |
| **Stampede prevention** | 100 concurrent requests for the same key = 1 fetcher execution |
| **Distributed single-flight** | Cross-instance dedup via Redis locks with lease renewal |
| **Bulk operations** | `getMany()` / `setMany()` / `mdelete()` with layer-level fast paths |
| **`wrap()` API** | Transparent function caching with automatic key derivation |
| **Namespaces** | Scoped cache views with hierarchical prefix support |
| **Cache warming** | Pre-populate layers at startup with priority-based loading |
| **Negative caching** | Cache misses (e.g., "user not found") for short TTLs |

### Invalidation & Freshness

| Feature | What it does |
|---|---|
| **Tag invalidation** | Delete all keys with a given tag across all layers |
| **Batch tag invalidation** | Multi-tag operations with `any` / `all` semantics |
| **Wildcard & prefix invalidation** | Glob-style and hierarchical key patterns |
| **Generation-based rotation** | Bulk namespace invalidation without scanning |
| **Stale-while-revalidate** | Return cached value, refresh in background |
| **Stale-if-error** | Keep serving stale when upstream fails |
| **Sliding TTL** | Reset expiry on every read for frequently-accessed keys |
| **Adaptive TTL** | Auto-ramp TTL for hot keys up to a ceiling |
| **Refresh-ahead** | Proactively refresh before expiry |
| **TTL policies** | Align expirations to calendar boundaries (`until-midnight`, `next-hour`, custom) |

### Resilience & Operations

| Feature | What it does |
|---|---|
| **Graceful degradation** | Skip failed layers temporarily, keep cache available |
| **Circuit breaker** | Stop hammering broken upstreams after repeated failures |
| **Fetcher rate limiting** | Scoped to global, per-key, or per-fetcher with custom buckets |
| **Write policies** | `strict` (fail if any layer fails) or `best-effort` |
| **Write-behind** | Batch writes with configurable flush interval |
| **Compression** | gzip / brotli in RedisLayer with configurable threshold |
| **MessagePack** | Pluggable serializers (JSON default, MessagePack alternative) |
| **Persistence** | Export/import snapshots to memory or disk |

### Observability

| Feature | What it does |
|---|---|
| **Metrics** | Hits, misses, fetches, stale hits, circuit breaker trips, and more |
| **Per-layer latency** | Avg, max, and sample count using Welford's algorithm |
| **Health checks** | Async health endpoint per layer with latency measurement |
| **Event hooks** | `hit`, `miss`, `set`, `delete`, `stale-serve`, `stampede-dedupe`, `backfill`, `warm`, `error` |
| **OpenTelemetry** | Hook-based distributed tracing support without method monkey-patching |
| **Prometheus exporter** | Metrics export including latency gauges |
| **HTTP stats handler** | JSON endpoint for dashboards |
| **Admin CLI** | `npx layercache stats\|keys\|invalidate` for Redis-backed caches |

</details>

---

## Integrations

layercache plugs into the frameworks you already use:

| Framework | Integration |
|---|---|
| **Express** | `createExpressCacheMiddleware(cache, opts)` - auto-caches responses with `x-cache: HIT/MISS` header |
| **Fastify** | `createFastifyLayercachePlugin(cache, opts)` - registers `fastify.cache` with optional stats route |
| **Hono** | `createHonoCacheMiddleware(cache, opts)` - edge-compatible middleware |
| **tRPC** | `createTrpcCacheMiddleware(cache, prefix, opts)` - procedure middleware |
| **GraphQL** | `cacheGraphqlResolver(cache, prefix, resolver, opts)` - field resolver wrapper |
| **Next.js** | Works natively with App Router and API routes |
| **OpenTelemetry** | `createOpenTelemetryPlugin(cache, tracer)` - event-driven tracing spans without monkey-patching |

<details>
<summary><b>Express example</b></summary>

```ts
import { CacheStack, MemoryLayer, createExpressCacheMiddleware } from 'layercache'

const cache = new CacheStack([new MemoryLayer({ ttl: 60 })])

app.get('/api/users', createExpressCacheMiddleware(cache, {
  ttl: 30,
  tags: ['users'],
  keyResolver: (req) => `users:${req.url}`
}), async (req, res) => {
  res.json(await db.getUsers())
})
```

</details>

<details>
<summary><b>Next.js App Router example</b></summary>

```ts
export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const data = await cache.get(`user:${params.id}`, () => db.findUser(Number(params.id)))
  return Response.json(data)
}
```

</details>

---

## Distributed Deployments

layercache is built for multi-instance production environments:

```
  ┌───────────┐    ┌───────────┐    ┌───────────┐
  │ Server A  │    │ Server B  │    │ Server C  │
  │ [Memory]  │    │ [Memory]  │    │ [Memory]  │
  └─────┬─────┘    └─────┬─────┘    └─────┬─────┘
        │                │                │
        └──── Redis Pub/Sub ──────────────┘  <-- L1 invalidation bus
                     │
               ┌─────┴──────┐
               │   Redis    │  <-- shared L2 + tag index + single-flight
               └────────────┘
```

- **Redis single-flight** - dedup misses across instances with distributed locks
- **Redis invalidation bus** - pub/sub-based L1 invalidation for memory consistency
- **Redis tag index** - shared tag tracking with optional sharding
- **Snapshot persistence** - export/import state between instances

<details>
<summary><b>Full distributed setup</b></summary>

```ts
import {
  CacheStack, MemoryLayer, RedisLayer,
  RedisInvalidationBus, RedisTagIndex, RedisSingleFlightCoordinator
} from 'layercache'

const redis = new Redis()
const bus = new RedisInvalidationBus({ publisher: redis, subscriber: new Redis() })
const tagIndex = new RedisTagIndex({ client: redis, prefix: 'myapp:tags' })
const coordinator = new RedisSingleFlightCoordinator({ client: redis })

const cache = new CacheStack(
  [
    new MemoryLayer({ ttl: 60, maxSize: 10_000 }),
    new RedisLayer({ client: redis, ttl: 3600, prefix: 'myapp:cache:' })
  ],
  {
    invalidationBus: bus,
    tagIndex: tagIndex,
    singleFlightCoordinator: coordinator,
    gracefulDegradation: { retryAfterMs: 10_000 }
  }
)
```

</details>

---

## Documentation

| Document | Description |
|---|---|
| [API Reference](./docs/api.md) | Complete API documentation with all options |
| [Tutorial](./docs/tutorial.md) | Step-by-step operational walkthrough |
| [Comparison Guide](./docs/comparison.md) | Detailed feature comparison with alternatives |
| [Migration Guide](./docs/migration-guide.md) | Migrate from node-cache-manager, keyv, or cacheable |
| [Benchmarking](./docs/benchmarking.md) | Benchmark scenarios and methodology |
| [Changelog](./CHANGELOG.md) | Version history and breaking changes |

---

## Examples

The [`examples/`](./examples) directory contains ready-to-run projects:

- [`express-api/`](./examples/express-api/) - Express REST API with layered caching
- [`nextjs-api-routes/`](./examples/nextjs-api-routes/) - Next.js App Router with layercache

---

## Requirements

- **Node.js** >= 20
- **TypeScript** >= 5.0 (optional - fully typed, ships `.d.ts`)
- **ioredis** >= 5 (optional - only needed for Redis features)

<sub>Runtime dependencies: `async-mutex` and `@msgpack/msgpack`</sub>

---

## Contributing

Contributions welcome - bug fixes, docs, performance, new adapters, or issues.

```bash
git clone https://github.com/flyingsquirrel0419/layercache
cd layercache
npm install
npm run lint && npm test && npm run build:all
```

See the [Contributing Guide](./CONTRIBUTING.md) and [Code of Conduct](./CODE_OF_CONDUCT.md).

---

## License

[Apache 2.0](./LICENSE) - use it freely in personal and commercial projects.

---

<p align="center">
  If layercache saves you time, consider giving it a <a href="https://github.com/flyingsquirrel0419/layercache">star on GitHub</a>. It helps others discover the project.
</p>
