# Benchmarking Guide

How to reproduce the real Redis-backed benchmark suite shipped with this repository.

> [Back to README](../README.md)

---

## Quick Start

Run the included benchmarks:

```bash
npm run bench:all

# Or run scenarios independently:
npm run bench:direct
npm run bench:edge
npm run bench:slow-redis
npm run bench:queue-amplification
npm run bench:http
npm run bench:multi-process-fanout
```

The suite starts a dedicated Docker Redis container named `layercache-bench-redis` on port `6390`. The workload fixture defaults to `/root/cache-test/data/users.json`, then falls back to `LAYERCACHE_BENCH_FIXTURE_PATH`, then `./data/users.json`. Cache TTLs are specified in milliseconds, matching the public API.

---

## Included Benchmarks

### Direct Cache Benchmark (`npm run bench:direct`)

Measures direct cache behavior against a real workload with file I/O plus CPU hashing:

| Scenario | What it measures |
|---|---|
| `cold-miss` | Origin fetch plus cache fill |
| `warm-hit` | Memory and layered hot-hit latency |
| `stampede` | Concurrent cold-key collapse and fetch count |

### HTTP Benchmark (`npm run bench:http`)

Runs `autocannon` against a local HTTP server exposing `/nocache`, `/memory`, and `/layered`.

### Edge Benchmark (`npm run bench:edge`)

Covers production edge cases that do not show up in a simple latency chart:

| Scenario | What it measures |
|---|---|
| TTL expiry stampede | Post-expiry collapse under burst traffic |
| Payload variation | 1KB vs 1MB warm-hit latency |
| Redis outage | strict vs graceful degradation behavior |
| Multi-instance invalidation | Redis pub/sub invalidation propagation |
| Distributed single-flight | cross-instance fetch collapse |

### Slow Redis Benchmark (`npm run bench:slow-redis`)

Combines two reports:

| Scenario | What it measures |
|---|---|
| `slow-redis-latency` | 0ms, 100ms, and 500ms induced Redis RTT with `commandTimeoutMs` enabled |
| `memory-pressure` | L1 eviction churn, revisit latency, GC, and event-loop lag |

### Queue Amplification (`npm run bench:queue-amplification`)

Measures how L2-hit latency scales under concurrent demand when Redis latency is injected through a proxy.

### Multi-Process Fan-Out (`npm run bench:multi-process-fanout`)

Runs multiple Node worker processes against one Redis instance to validate:

| Scenario | What it measures |
|---|---|
| `multi-process-invalidation` | cross-process invalidation visibility delay |
| `multi-process-distributed-single-flight` | origin fetch count under cross-process burst traffic |

---

## Environment

- Node.js 20+
- Docker daemon available locally
- Redis image `redis:7-alpine`
- Fixture file at `/root/cache-test/data/users.json`, `LAYERCACHE_BENCH_FIXTURE_PATH`, or `./data/users.json`

The benchmark utilities automatically prefer `/root/cache-test/data/users.json` so results stay aligned with the external benchmark workspace the reports were generated from.

---

## Latest Verified Baseline

Measured on 2026-07-16 from the `4.0.0` main branch after running each benchmark scenario listed in the quick start:

| Component | Measured environment |
|---|---|
| Runtime | Node.js 24.16.0 on Linux 6.8 x86_64 |
| Compute | 2 vCPU on an AMD Ryzen 9 9900X host, 3.8 GiB RAM |
| Redis | Redis 7.4.9 (`redis:7-alpine`) in Docker 29.1.3 |
| Cache TTLs | Memory 60,000ms; Redis 300,000ms; TTL-expiry scenario 1,000ms |
| Direct workload | 5,000-user JSON fixture, file read, and 600 SHA-256 rounds per origin fetch |

### Direct cache

| Mode / scenario | Samples | Avg | p95 | Min | Max | Origin fetches |
|---|---:|---:|---:|---:|---:|---:|
| No cache / warm workload | 120 | 3.729ms | 4.789ms | 3.020ms | 5.937ms | 120 |
| Memory / warm hit | 120 | 0.013ms | 0.035ms | 0.004ms | 0.543ms | 0 |
| Layered / warm L1 hit | 120 | 0.009ms | 0.026ms | 0.003ms | 0.158ms | 0 |
| Layered / cold miss | 15 | 5.326ms | 7.299ms | 4.267ms | 7.299ms | 15 |

Across five 75-request cold bursts, no-cache mode executed the origin 375 times. Memory and layered modes each executed it five times: once per burst.

### HTTP throughput

Each route used 40 connections, one pipelined request per connection, and an 8-second run.

| Route | Requests/sec | Avg latency | p97.5 | Max | Errors | Timeouts |
|---|---:|---:|---:|---:|---:|---:|
| `/nocache` | 261.25 | 153.88ms | 203ms | 661ms | 0 | 0 |
| `/memory` | 38,151 | 0.40ms | 2ms | 32ms | 0 | 0 |
| `/layered` | 37,600 | 0.42ms | 2ms | 21ms | 0 | 0 |

### Edge and distributed behavior

| Scenario | Result |
|---|---|
| Post-expiry burst | 40 requests collapsed to one fetch per run; memory averaged 0.616ms and layered averaged 4.128ms across five runs |
| 1KB Redis warm hit | 0.206ms average, 0.382ms p95 across 60 samples |
| 1MB Redis warm hit | 2.357ms average, 5.041ms p95 across 60 samples |
| Multi-instance invalidation | Updated value observed in 0.247ms |
| Two-instance distributed single-flight | 60 concurrent requests, one origin fetch, 55.877ms wall clock |
| Four-process distributed single-flight | 100 concurrent requests, one origin fetch, 379.745ms wall clock |
| Four-process invalidation | Updated value observed in 6.827ms |

### Slow Redis, queueing, and memory pressure

With a 200ms command timeout, a 500ms Redis delay caused strict reads to fail at the timeout boundary while graceful mode fell back successfully. At 100ms induced latency, a strict L2 hit measured 101.496ms; at zero induced latency it measured 2.947ms.

Queue-amplification wall-clock results stayed close to the injected Redis delay at high concurrency:

| Injected delay | 1 request | 500 concurrent | Wall-clock amplification |
|---|---:|---:|---:|
| 0ms | 3.479ms | 20.452ms | 5.879x |
| 100ms | 101.418ms | 116.317ms | 1.147x |
| 500ms | 501.736ms | 513.461ms | 1.023x |

The memory-pressure scenario inserted 180 unique 256KB payloads into a 25-entry L1. It retained 25 entries, revisited evicted keys from Redis at 0.704ms average / 0.745ms p95 with zero origin fetches, and recorded a 13.132ms maximum event-loop delay.

These numbers are a reproducible baseline from one host, not a performance guarantee. Run the suite on deployment-like hardware and keep the raw JSON output when comparing releases.

---

## Compression Guidance

`RedisLayer` compression is intentionally opt-in, but large payload benchmarks show it matters for multi-hundred-KB and MB-sized values. For large cached documents or API payloads, start with:

```ts
new RedisLayer({
  client: redis,
  ttl: 300_000,
  compression: 'brotli',
  compressionThreshold: 1_024 * 1_024
})
```

---

## Reporting Format

When sharing benchmark results, include:

- **Environment**: Node.js version, Redis version, OS, CPU, memory, Docker version
- **Layer configuration**: Layers, TTLs, max sizes, compression settings
- **Metrics**: Average latency, p50, p95, p99
- **Concurrency**: Number of concurrent requests
- **Fetcher execution count**: Especially for stampede and multi-process tests
- **Sample size**: Number of iterations

Example:

```
Environment: Node 22.1.0, Redis 7.2, Docker 28.x, Linux x64, 16GB RAM
Layers: MemoryLayer(ttl=60, maxSize=5000) + RedisLayer(ttl=300, brotli)
Concurrency: 50 parallel requests

| Scenario      | avg    | p50    | p95    | p99    | samples |
|---------------|--------|--------|--------|--------|---------|
| L1 hit        | 0.006  | 0.005  | 0.010  | 0.015  | 10,000  |
| L2 hit        | 0.42   | 0.38   | 0.65   | 1.2    | 10,000  |
| Miss (fetch)  | 18.3   | 17.1   | 25.0   | 32.0   | 1,000   |
```

---

## Tips

- **Warm up** the JIT before measuring: run a few hundred iterations as a warm-up phase before recording.
- **Isolate Redis**: Use a dedicated Redis instance for benchmarks, not your development server.
- **Test realistic payloads**: Use JSON objects similar in size and shape to your actual data.
- **Test under load**: Single-request latency is less interesting than behavior under concurrent load.
- **Use command timeouts**: Slow Redis only degrades gracefully if slow commands are surfaced as errors. Set `commandTimeoutMs` on `RedisLayer` and `RedisSingleFlightCoordinator` when benchmarking degradation behavior.

> [Back to README](../README.md)
