# Comparison Guide

How does layercache compare to other popular Node.js caching libraries?

> [Back to README](../README.md)

---

## Overview

| Capability | layercache | BentoCache | node-cache-manager | keyv | cacheable |
|---|:---:|:---:|:---:|:---:|:---:|
| Multi-layer with auto backfill | **Yes** | Partial | Partial | Plugin | -- |
| Stampede prevention | **Yes** | Partial | -- | -- | -- |
| Distributed single-flight | **Yes** | -- | -- | -- | -- |
| Tag invalidation | **Yes** | Yes | -- | -- | Yes |
| Distributed tags | **Yes** | -- | -- | -- | -- |
| Cross-server L1 flush | **Yes** | Yes | -- | -- | -- |
| Stale-while-revalidate | **Yes** | Yes | -- | -- | -- |
| Circuit breaker | **Yes** | Yes | -- | -- | -- |
| Graceful degradation | **Yes** | Yes | -- | -- | -- |
| Sliding / adaptive TTL | **Yes** | -- | -- | -- | -- |
| Cache warming | **Yes** | -- | -- | -- | -- |
| Persistence / snapshots | **Yes** | -- | -- | -- | -- |
| Compression | **Yes** | -- | -- | -- | Yes |
| Admin CLI | **Yes** | -- | -- | -- | -- |
| TypeScript-first | **Yes** | Yes | Partial | Yes | Yes |
| Wrap / decorator API | **Yes** | Partial | Yes | -- | -- |
| Namespaces | **Yes** | Yes | -- | Yes | Yes |
| Event hooks | **Yes** | Yes | Yes | Yes | Yes |
| Custom layers | **Yes** | Yes | Partial | -- | -- |

---

## layercache vs. node-cache-manager

**node-cache-manager** is a well-known multi-store cache with a `wrap()` API. It provides basic layered caching but stops there.

**Where layercache goes further:**

- **Auto backfill** - When L2 has the value but L1 doesn't, layercache automatically fills L1. node-cache-manager requires you to handle this manually.
- **Stampede prevention** - Built-in request deduplication. node-cache-manager has no protection against thundering herds.
- **Tag invalidation** - Invalidate groups of related keys by tag. node-cache-manager only supports key-by-key deletion.
- **Distributed consistency** - Redis pub/sub invalidation bus and shared tag index for multi-instance deployments.
- **Stale serving** - Stale-while-revalidate and stale-if-error strategies out of the box.
- **Operational tooling** - Health checks, metrics, Prometheus exporter, admin CLI, OpenTelemetry support.
- **Resilience** - Circuit breakers, graceful degradation, fetcher rate limiting.

**When node-cache-manager might be enough:**
- Simple single-instance apps with basic get/set/wrap needs
- Projects that already depend on it and don't need advanced features

---

## layercache vs. keyv

**keyv** is a simple key-value storage with a clean API and many backend adapters.

**Where layercache goes further:**

- **True multi-layer** - layercache orchestrates reads across layers with automatic backfill. keyv's tiered storage is a plugin with limited integration.
- **Stampede prevention** - keyv has no built-in deduplication for concurrent requests.
- **Invalidation model** - Tags, patterns, prefixes, and generation-based rotation vs. key-by-key deletion.
- **Stale serving** - No stale-while-revalidate or stale-if-error in keyv.
- **Production features** - No cache warming, circuit breakers, health checks, or metrics in keyv.

**When keyv might be enough:**
- Simple key-value storage across many backends
- You need broad backend support (SQLite, PostgreSQL, MongoDB) and don't need advanced caching features

---

## layercache vs. cacheable

**cacheable** provides a caching layer with tag support and hooks.

**Where layercache goes further:**

- **Multi-layer orchestration** - cacheable has basic layering. layercache provides full read-through with auto backfill across any number of layers.
- **Stampede prevention** - Not available in cacheable.
- **Distributed consistency** - Redis pub/sub invalidation bus, distributed tag index, and single-flight coordination.
- **Resilience** - Circuit breakers, graceful degradation, and fetcher rate limiting.
- **Operational tooling** - Admin CLI, Prometheus exporter, OpenTelemetry, stats endpoints.
- **Freshness strategies** - Stale-while-revalidate, refresh-ahead, sliding TTL, adaptive TTL.

**When cacheable might be enough:**
- Tag-based invalidation with simple caching needs
- Projects that already use it and don't need distributed features

---

## layercache vs. BentoCache

[BentoCache](https://bentocache.dev) (v1.6.1) is a TypeScript caching library with a two-tier architecture (L1 local + L2 remote), a rich driver ecosystem, and deep AdonisJS integration. It is one of the closest feature comparisons for layercache.

### Where BentoCache shines

- **Driver ecosystem** - Redis, Memory, Filesystem, DynamoDB, and Database drivers (Knex, Kysely, Orchid) for SQLite, MySQL, PostgreSQL, and MSSQL. Broader backend coverage than layercache.
- **AdonisJS integration** - Official `@adonisjs/cache` package with full framework integration.
- **Friendly TTLs** - Human-readable strings like `'2.5h'`, `'10m'`, `'30s'` everywhere a TTL is accepted.
- **Factory Context API** - `ctx.skip()`, `ctx.fail()`, `ctx.gracedEntry`, `ctx.setOptions()` give the factory fine-grained control over caching behavior.
- **Grace backoff** - When the factory fails during the grace window, TTL is extended by a backoff duration to prevent upstream hammering.
- **Soft and hard timeouts** - Return stale data after a soft timeout while the factory continues in background; hard timeout throws an explicit error.
- **Plugin system** - Extensible via a `register(bentocache)` interface. Plugins receive the full instance and can subscribe to events, attach metrics, and more.
- **Binary bus encoding** - Bus messages use a custom binary format instead of JSON for bandwidth savings.
- **Grafana dashboard** - Ready-to-use Prometheus metrics with a bundled Grafana dashboard.
- **Driver compliance test suite** - Ships `bentocache/test_suite` to validate custom driver implementations.

### Where layercache goes further

- **N-layer stacks** - layercache supports any number of layers (Memory + Redis + Disk + …). BentoCache is limited to exactly two tiers (L1 + L2).
- **Distributed single-flight** - Cross-instance request deduplication via Redis distributed locks. BentoCache's stampede protection is in-memory only — N instances can produce up to N concurrent factory calls for the same key.
- **Distributed tags** - Shared Redis-backed tag index (`RedisTagIndex`). BentoCache tags are local-only, using client-side invalidation timestamps without a shared index.
- **Wildcard and pattern invalidation** - Glob-style key pattern matching (`user:*`). Not available in BentoCache.
- **Generation-based rotation** - Bulk namespace invalidation by bumping a generation number, without scanning keys.
- **Sliding TTL** - Reset expiry on every read for frequently accessed keys.
- **Adaptive TTL** - Automatically ramp TTL for hot keys up to a configurable ceiling.
- **Refresh-ahead** - Proactively refresh values before they expire.
- **TTL policies** - Calendar-aligned expirations (`until-midnight`, `next-hour`, custom).
- **Cache warming** - Priority-based pre-population at startup with progress callbacks.
- **Persistence and snapshots** - Export/import cache state for recovery and migration.
- **Compression** - Built-in gzip and brotli compression in RedisLayer with configurable thresholds.
- **MessagePack serializer** - Binary serialization as a built-in alternative to JSON.
- **Admin CLI** - `npx layercache stats|keys|invalidate|inspect` for operational debugging.
- **Health checks** - Per-layer async health endpoints with latency measurement.
- **Per-layer latency tracking** - Average, max, and sample count using Welford's algorithm.
- **HTTP stats endpoint** - JSON endpoint for dashboards and monitoring.
- **Framework middleware** - Express, Fastify, Hono, tRPC, GraphQL, and Next.js integrations out of the box.
- **Write-behind** - Batch writes to non-local layers with configurable flush interval.
- **Fetcher rate limiting** - Token-bucket rate limiting scoped globally, per-key, or per-fetcher.
- **Negative caching** - Dedicated support for caching miss results with short TTLs.

### When BentoCache might be enough

- AdonisJS projects that want seamless framework integration
- Apps that need DynamoDB or SQL database backends
- Teams that prefer friendly TTL strings and a rich factory context API
- Simple two-tier caching with Redis and an in-memory layer

---

## Migration

Ready to switch? See the [Migration Guide](./migration-guide.md) for step-by-step instructions.

> [Back to README](../README.md)
