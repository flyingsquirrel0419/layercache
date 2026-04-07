# Comparison Guide

How does layercache compare to other popular Node.js caching libraries?

> [Back to README](../README.md)

---

## Overview

| Capability | layercache | node-cache-manager | keyv | cacheable |
|---|:---:|:---:|:---:|:---:|
| Multi-layer with auto backfill | **Yes** | Partial | Plugin | -- |
| Stampede prevention | **Yes** | -- | -- | -- |
| Distributed single-flight | **Yes** | -- | -- | -- |
| Tag invalidation | **Yes** | -- | -- | Yes |
| Distributed tags | **Yes** | -- | -- | -- |
| Cross-server L1 flush | **Yes** | -- | -- | -- |
| Stale-while-revalidate | **Yes** | -- | -- | -- |
| Circuit breaker | **Yes** | -- | -- | -- |
| Graceful degradation | **Yes** | -- | -- | -- |
| Sliding / adaptive TTL | **Yes** | -- | -- | -- |
| Cache warming | **Yes** | -- | -- | -- |
| Persistence / snapshots | **Yes** | -- | -- | -- |
| Compression | **Yes** | -- | -- | Yes |
| Admin CLI | **Yes** | -- | -- | -- |
| NestJS module | **Yes** | -- | -- | -- |
| TypeScript-first | **Yes** | Partial | Yes | Yes |
| Wrap / decorator API | **Yes** | Yes | -- | -- |
| Namespaces | **Yes** | -- | Yes | Yes |
| Event hooks | **Yes** | Yes | Yes | Yes |
| Custom layers | **Yes** | Partial | -- | -- |

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
