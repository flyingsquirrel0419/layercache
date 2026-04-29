# Comparison Guide

How does layercache compare to other popular Node.js caching libraries?

> [Back to README](../README.md)

---

## Overview

| Capability | layercache | BentoCache | node-cache-manager | keyv | cacheable |
|---|:---:|:---:|:---:|:---:|:---:|
| Multi-layer with auto backfill | **Yes** | Yes | Partial | Plugin | -- |
| Stampede prevention | **Yes** | Yes | -- | -- | -- |
| Distributed single-flight | **Yes** | Per-instance lock | -- | -- | -- |
| Tag invalidation | **Yes** | Yes | -- | -- | Yes |
| Expire without deleting stale values | **Yes** | Timestamp-based tags | -- | -- | -- |
| Distributed tags | **Yes** | Yes | -- | -- | -- |
| Cross-server L1 flush | **Yes** | Yes | -- | -- | -- |
| Stale-while-revalidate | **Yes** | Yes | -- | -- | -- |
| Stale-if-error / grace period | **Yes** | Yes | -- | -- | -- |
| Circuit breaker | **Yes** | -- | -- | -- | -- |
| Graceful degradation | **Yes** | Yes | -- | -- | -- |
| Factory timeout controls | **Yes** | Yes | -- | -- | -- |
| Sliding / adaptive TTL | **Yes** | Refresh threshold | -- | -- | -- |
| Cache warming | **Yes** | -- | -- | -- | -- |
| Persistence / snapshots | **Yes** | Driver-dependent | -- | -- | -- |
| Compression | **Yes** | Driver-dependent | -- | -- | Yes |
| Admin CLI | **Yes** | -- | -- | -- | -- |
| TypeScript-first | **Yes** | Yes | Partial | Yes | Yes |
| Wrap / decorator API | **Yes** | getOrSet API | Yes | -- | -- |
| Namespaces | **Yes** | Yes | -- | Yes | Yes |
| Event hooks | **Yes** | Yes | Yes | Yes | Yes |
| OpenTelemetry integration | **Yes** | Yes | -- | -- | -- |
| Custom layers | **Yes** | Yes | Partial | -- | -- |

---

## layercache vs. BentoCache

**BentoCache** is the closest comparison in this list. It is a full-featured Node.js caching library with L1/L2 stores, local-cache synchronization over a bus, stampede protection, grace periods, soft/hard factory timeouts, namespaces, tags, events, logging, OpenTelemetry, and many official drivers.

**Where layercache is similar:**

- **Multi-layer caching** - both libraries combine fast local memory with a shared/distributed cache and can synchronize local caches between instances.
- **Stale serving** - both can serve stale data while refreshing in the background.
- **Stampede protection** - both avoid running the same expensive factory many times concurrently within an instance.
- **Tag and namespace workflows** - both support grouping keys and invalidating groups rather than deleting one key at a time.
- **Observability** - both expose events and OpenTelemetry-friendly instrumentation paths.

**Where layercache goes further or chooses a different tradeoff:**

- **Explicit layer stack** - layercache exposes a direct `CacheStack([new MemoryLayer(), new RedisLayer(), ...])` model. BentoCache uses named stores and drivers, which is flexible but more framework-like.
- **Direct key discovery invalidation** - layercache supports tag, tag-set, glob pattern, prefix, and generation-based invalidation. BentoCache's documented tag model avoids scanning by storing tag invalidation timestamps and checking them on read.
- **Expire without deletion** - layercache has `expireByTag()`, `expireByTags()`, `expireByPattern()`, and `expireByPrefix()` for marking entries stale while keeping stale values available for SWR. BentoCache's tag invalidation is timestamp-based, so entries can be considered stale without eagerly deleting the backing values, but its public API is centered on `deleteByTag()`.
- **Operational controls** - layercache includes an admin CLI, snapshot import/export, Prometheus exporter, health checks, Redis-backed distributed single-flight coordination, circuit breakers, fetcher rate limiting, refresh-ahead, sliding TTL, adaptive TTL, and generation rotation as first-class APIs.
- **Built-in layer implementations** - layercache focuses on memory, Redis, disk, and Memcached layers with consistent envelope semantics. BentoCache currently has broader official driver coverage, including Redis-compatible providers, filesystem, DynamoDB, SQL drivers, and ORM-backed drivers.

**Where BentoCache may be a better fit:**

- You want a larger official driver catalog out of the box, especially database, DynamoDB, Upstash/Vercel KV, or ORM-backed stores.
- You prefer backend-agnostic tag invalidation based on tag timestamps rather than maintaining key-to-tag indexes.
- You want friendly TTL strings and cache size strings as part of the public API.
- You like its store/driver abstraction and named-cache style for a larger application.

**When layercache is likely a better fit:**

- You want direct control over the exact layer stack and per-layer TTL behavior.
- You need explicit prefix, pattern, tag-set, generation, or expire-without-delete operations.
- You want cache operations to integrate tightly with built-in metrics, admin CLI workflows, snapshots, circuit breakers, and Redis single-flight coordination.
- You prefer a smaller built-in set of production layers with consistent stale envelope semantics across them.

References: [BentoCache introduction](https://bentocache.dev/docs/introduction), [BentoCache tagging](https://bentocache.dev/docs/tagging), [BentoCache drivers](https://bentocache.dev/docs/cache-drivers), [BentoCache timeouts](https://bentocache.dev/docs/timeouts), [BentoCache stampede protection](https://bentocache.dev/docs/stampede-protection).

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

## Migration

Ready to switch? See the [Migration Guide](./migration-guide.md) for step-by-step instructions.

> [Back to README](../README.md)
