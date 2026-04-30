# Benchmarking Guide

How to reproduce the real Redis-backed benchmark suite shipped with this repository.

> [Back to README](../README.md)

---

## Quick Start

Run the included benchmarks:

```bash
npm run bench:direct
npm run bench:edge
npm run bench:slow-redis
npm run bench:queue-amplification
npm run bench:http
npm run bench:multi-process-fanout
```

The suite starts a dedicated Docker Redis container named `layercache-bench-redis` on port `6390`. The workload fixture defaults to `/root/cache-test/data/users.json`, then falls back to `LAYERCACHE_BENCH_FIXTURE_PATH`, then `./data/users.json`.

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
