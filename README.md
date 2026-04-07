<p align="center">
  <img src="./logo.png" width="520" alt="layercache logo">
</p>

<h1 align="center">layercache</h1>

<p align="center">
  <strong>The multi-layer caching toolkit that Node.js deserves.</strong><br>
  <em>Stack memory + Redis + disk. One API. Zero stampedes.</em>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/layercache"><img src="https://img.shields.io/npm/v/layercache?color=cb3837&label=npm" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/layercache"><img src="https://img.shields.io/npm/dw/layercache?color=blue" alt="npm downloads"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/npm/l/layercache?color=green" alt="license"></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-first-3178C6?logo=typescript&logoColor=white" alt="TypeScript"></a>
  <img src="https://img.shields.io/badge/Node.js-%E2%89%A5_20-339933?logo=nodedotjs&logoColor=white" alt="Node.js >= 20">
  <img src="https://img.shields.io/badge/tests-180%2B_passing-brightgreen" alt="tests">
  <img src="https://img.shields.io/badge/zero_dependencies*-grey" alt="zero runtime deps">
</p>

<p align="center">
  <a href="#-quick-start">Quick Start</a>&nbsp;&nbsp;|&nbsp;&nbsp;
  <a href="#-features">Features</a>&nbsp;&nbsp;|&nbsp;&nbsp;
  <a href="./docs/api.md">API Reference</a>&nbsp;&nbsp;|&nbsp;&nbsp;
  <a href="#-integrations">Integrations</a>&nbsp;&nbsp;|&nbsp;&nbsp;
  <a href="#-comparison">Comparison</a>&nbsp;&nbsp;|&nbsp;&nbsp;
  <a href="./docs/tutorial.md">Tutorial</a>&nbsp;&nbsp;|&nbsp;&nbsp;
  <a href="./docs/migration-guide.md">Migration Guide</a>
</p>

---

## The Problem

Every growing Node.js service hits the same caching wall:

```
Memory-only cache    --> Fast, but each instance has a different view of data
Redis-only cache     --> Shared, but every request pays a network round-trip
Hand-rolled hybrid   --> Works... until you need stampede prevention, invalidation,
                         stale serving, observability, and distributed consistency
```

## The Solution

**layercache** gives you a unified multi-layer cache with production-grade features built in:

```
                    ┌──────────────────────────────────────────┐
  your app -------->│            layercache                    │
                    │                                          │
                    │   L1 Memory     ~0.01ms   (per-process)  │
                    │       |                                   │
                    │   L2 Redis      ~0.5ms    (shared)       │
                    │       |                                   │
                    │   L3 Disk       ~2ms      (persistent)   │
                    │       |                                   │
                    │   Fetcher       ~20ms     (runs once)    │
                    └──────────────────────────────────────────┘

  On a hit  --> serves the fastest layer, backfills the rest
  On a miss --> fetcher runs ONCE (even under 100x concurrency)
```

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

## Features

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
| **OpenTelemetry** | Distributed tracing support |
| **Prometheus exporter** | Metrics export including latency gauges |
| **HTTP stats handler** | JSON endpoint for dashboards |
| **Admin CLI** | `npx layercache stats\|keys\|invalidate` for Redis-backed caches |

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
| **NestJS** | `@cachestack/nestjs` - `CacheStackModule.forRoot()`, `@Cacheable()` decorator |
| **Next.js** | Works natively with App Router and API routes |
| **OpenTelemetry** | `createOpenTelemetryPlugin(cache, tracer)` - distributed tracing spans |

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
<summary><b>NestJS example</b></summary>

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

// user.service.ts
@Injectable()
export class UserService {
  constructor(@InjectCacheStack() private readonly cache: CacheStack) {}

  async getUser(id: number) {
    return this.cache.get(`user:${id}`, () => this.db.findUser(id))
  }
}
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
  ┌──────────┐    ┌──────────┐    ┌──────────┐
  │ Server A  │    │ Server B  │    │ Server C  │
  │ [Memory]  │    │ [Memory]  │    │ [Memory]  │
  └─────┬─────┘    └─────┬─────┘    └─────┬─────┘
        │                │                │
        └──── Redis Pub/Sub ──────────────┘  <-- L1 invalidation bus
                     │
               ┌─────┴─────┐
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

## Performance

```
┌─────────────────────┬──────────────┐
│ Scenario            │ Avg Latency  │
├─────────────────────┼──────────────┤
│ L1 memory hit       │   ~0.006 ms  │
│ L2 Redis hit        │   ~0.020 ms  │
│ No cache (sim. DB)  │   ~1.08  ms  │
└─────────────────────┴──────────────┘

┌─────────────────────┬────────┐
│ concurrentRequests  │  100   │
│ fetcherExecutions   │    1   │  <-- stampede prevention
└─────────────────────┴────────┘
```

Run benchmarks locally:

```bash
npm run bench:latency
npm run bench:stampede
```

---

## Comparison

|  | node-cache-manager | keyv | cacheable | **layercache** |
|---|:---:|:---:|:---:|:---:|
| Multi-layer with auto backfill | Partial | Plugin | -- | **Yes** |
| Stampede prevention | -- | -- | -- | **Yes** |
| Distributed single-flight | -- | -- | -- | **Yes** |
| Tag invalidation | -- | -- | Yes | **Yes** |
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
| NestJS module | -- | -- | -- | **Yes** |
| TypeScript-first | Partial | Yes | Yes | **Yes** |
| Wrap / decorator API | Yes | -- | -- | **Yes** |
| Namespaces | -- | Yes | Yes | **Yes** |
| Event hooks | Yes | Yes | Yes | **Yes** |
| Custom layers | Partial | -- | -- | **Yes** |

> See the full [comparison guide](./docs/comparison.md) for detailed breakdowns.

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
- [`nestjs-module/`](./examples/nestjs-module/) - NestJS module integration
- [`nextjs-api-routes/`](./examples/nextjs-api-routes/) - Next.js App Router with layercache

---

## Requirements

- **Node.js** >= 20
- **TypeScript** >= 5.0 (optional - fully typed, ships `.d.ts`)
- **ioredis** >= 5 (optional - only needed for Redis features)

<sub>* `async-mutex` and `@msgpack/msgpack` are the only runtime dependencies</sub>

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
