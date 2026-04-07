# Benchmarking Guide

How to measure and report layercache performance.

> [Back to README](../README.md)

---

## Quick Start

Run the included benchmarks:

```bash
npm run bench:latency    # Layer hit latency comparison
npm run bench:stampede   # Stampede prevention verification
```

These use `ioredis-mock` and synthetic delays. Treat results as a sanity check - for production numbers, benchmark against your actual Redis instance.

---

## Included Benchmarks

### Latency Benchmark (`npm run bench:latency`)

Measures per-layer read latency:

| Scenario | What it measures |
|---|---|
| L1 memory hit | In-process read with no network |
| L2 Redis hit | Redis GET + deserialization + L1 backfill |
| Full miss | Fetcher execution + write to all layers |

Example output:

```
┌─────────────────────┬──────────────┐
│ Scenario            │ Avg Latency  │
├─────────────────────┼──────────────┤
│ L1 memory hit       │   ~0.006 ms  │
│ L2 Redis hit        │   ~0.020 ms  │
│ No cache (sim. DB)  │   ~1.08  ms  │
└─────────────────────┴──────────────┘
```

### Stampede Benchmark (`npm run bench:stampede`)

Verifies that concurrent requests for the same key result in a single fetcher execution:

```
┌─────────────────────┬────────┐
│ concurrentRequests  │  100   │
│ fetcherExecutions   │    1   │
└─────────────────────┴────────┘
```

---

## Recommended Test Scenarios

For comprehensive benchmarking, test these scenarios:

### 1. L1 Hit Latency (Memory Only)

Measures pure in-process read performance.

```ts
const cache = new CacheStack([new MemoryLayer({ ttl: 60, maxSize: 10_000 })])
await cache.set('key', value)

// Benchmark: repeated get('key')
```

### 2. L2 Hit Latency (Redis + Backfill)

Measures Redis read + automatic L1 backfill.

```ts
const cache = new CacheStack([
  new MemoryLayer({ ttl: 60 }),
  new RedisLayer({ client: redis, ttl: 300 })
])

// Prime L2 only, then benchmark get()
```

### 3. Full Miss with Single-Flight

Measures fetcher execution with distributed dedup.

```ts
const cache = new CacheStack([...], {
  singleFlightCoordinator: new RedisSingleFlightCoordinator({ client: redis })
})

// Benchmark: 100 concurrent get() calls for the same uncached key
```

### 4. Warm-Start Latency

Measures time to pre-populate cache from cold start.

```ts
const entries = Array.from({ length: 1000 }, (_, i) => ({
  key: `item:${i}`,
  fetcher: () => fetchItem(i)
}))

// Benchmark: cache.warm(entries, { concurrency: 10 })
```

### 5. Compression Impact

Compare Redis payload sizes and latency with and without compression.

```ts
// Without compression
new RedisLayer({ client: redis, ttl: 300 })

// With gzip
new RedisLayer({ client: redis, ttl: 300, compression: 'gzip' })

// With brotli
new RedisLayer({ client: redis, ttl: 300, compression: 'brotli' })
```

### 6. Tag Invalidation at Scale

Measure invalidation throughput with many tagged keys.

```ts
// Write 10,000 keys with tags
// Benchmark: cache.invalidateByTag('common-tag')
```

---

## Reporting Format

When sharing benchmark results, include:

- **Environment**: Node.js version, Redis version, OS, CPU, memory
- **Layer configuration**: Layers, TTLs, max sizes, compression settings
- **Metrics**: Average latency, p50, p95, p99
- **Concurrency**: Number of concurrent requests
- **Fetcher execution count**: Especially for stampede tests
- **Sample size**: Number of iterations

Example:

```
Environment: Node 22.1.0, Redis 7.2, macOS M2, 16GB RAM
Layers: MemoryLayer(ttl=60, maxSize=5000) + RedisLayer(ttl=300, gzip)
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

> [Back to README](../README.md)
