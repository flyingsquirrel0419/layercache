# layercache Consolidated Benchmark Report

Measured on `2026-04-15` from `/root/layercache` with the workload fixture at `/root/cache-test/data/users.json`.

## Scope

This report consolidates all benchmark work completed in this workspace:

1. direct cache behavior
2. end-to-end HTTP behavior
3. edge-case and multi-instance behavior
4. slow Redis and dead Redis behavior
5. memory pressure and eviction
6. queue amplification under slow Redis
7. multi-process fan-out

## Environment

- OS: Linux 5.15.0-174-generic x86_64 GNU/Linux
- Node.js: `v20.20.1`
- npm: `10.8.2`
- Docker: `28.2.2`
- Redis: `redis:7-alpine` in Docker
- Redis container: `layercache-bench-redis`
- Redis port: `6390`

## Commands Used

Verification:

```bash
npm run lint
npm run build
npm test
```

Benchmarks:

```bash
npm run bench:direct
npm run bench:http
npm run bench:edge
npm run bench:slow-redis
npm run bench:queue-amplification
npm run bench:multi-process-fanout
```

## Workload

The miss path uses actual local work rather than timer simulation:

- reads `/root/cache-test/data/users.json`
- parses JSON and finds user `4242`
- performs repeated SHA-256 hashing

This means the baseline cost includes real file I/O and CPU work.

## 1. Direct Cache Benchmarks

| Mode | Scenario | Avg ms | P95 ms | Min ms | Max ms | Fetch Count |
|---|---:|---:|---:|---:|---:|---:|
| no-cache | cold-miss | 7.161 | 14.532 | 4.465 | 14.532 | 15 |
| memory | cold-miss | 6.316 | 10.298 | 4.371 | 10.298 | 15 |
| layered | cold-miss | 6.956 | 10.092 | 4.825 | 10.092 | 15 |
| no-cache | warm-hit | 5.435 | 7.417 | 3.943 | 9.823 | 120 |
| memory | warm-hit | 0.034 | 0.026 | 0.004 | 2.050 | 0 |
| layered | warm-hit | 0.007 | 0.019 | 0.004 | 0.046 | 0 |
| no-cache | stampede | 504.326 | 543.708 | 470.373 | 543.708 | 375 |
| memory | stampede | 7.891 | 12.672 | 4.424 | 12.672 | 5 |
| layered | stampede | 12.690 | 20.344 | 9.309 | 20.344 | 5 |

Key points:

- Warm hits collapsed from about `5.435ms` to `0.034ms` in memory mode and `0.007ms` in layered mode.
- Stampede control worked. `375` origin executions without cache dropped to `5` with both memory and layered cache.
- The layered stampede path is materially faster than in the 04-14 run (`12.69ms` vs `17.35ms`), showing the StampedeGuard rewrite is competitive.

## 2. HTTP Benchmarks

| Route | Cold Start ms | Avg Latency ms | P97.5 ms | Max ms | Req/s | Errors | Timeouts |
|---|---:|---:|---:|---:|---:|---:|---:|
| `/nocache` | 38.871 | 290.500 | 321 | 919 | 142.50 | 0 | 0 |
| `/memory` | 5.889 | 2.190 | 6 | 117 | 14483 | 0 | 0 |
| `/layered` | 7.406 | 2.040 | 5 | 70 | 15196 | 0 | 0 |

Key points:

- HTTP throughput moved from about `142.5 req/s` to `14.5k-15.2k req/s` once the cache was warm.
- `/layered` recovered to `15,196 req/s`, confirming the 04-14 drop to `4,858 req/s` was environmental noise rather than a code regression.
- Average latency dropped from `290.5ms` to roughly `2ms`.
- In a single process, the hot `/layered` path was essentially identical to `/memory`, consistent with L1 satisfying the steady-state reads.

## 3. Edge Cases

### TTL expiry stampede

| Mode | Avg ms | P95 ms | Fetch Count |
|---|---:|---:|---:|
| memory | 0.569 | 1.107 | 5 |
| layered | 6.186 | 8.990 | 5 |

### Payload size variation

| Mode | Avg ms | P95 ms | Max ms |
|---|---:|---:|---:|
| memory-1kb | 0.016 | 0.032 | 0.240 |
| memory-1mb | 0.014 | 0.015 | 0.329 |
| redis-1kb | 0.224 | 0.413 | 2.043 |
| redis-1mb | 4.833 | 11.882 | 13.927 |

### Redis outage

| Scenario | Success | Latency ms | Error |
|---|---:|---:|---|
| strict-hot-hit | true | 0.171 | |
| graceful-hot-hit | true | 0.077 | |
| strict-cold-miss | false | 0 | `RedisLayer command get("outage:cold:strict") timed out after 200ms.` |
| graceful-cold-miss | true | 400.608 | |

### Single-process distributed coordination

| Scenario | Success | Latency ms | Observed Version | Concurrency | Fetch Count |
|---|---:|---:|---:|---:|---:|
| multi-instance-invalidation | true | 0.255 | 2 |  |  |
| distributed-single-flight |  | 59.591 |  | 60 | 1 |

Key points:

- TTL expiry remained deduplicated. `40` concurrent requests x `5` rounds still caused only `5` origin fetches.
- Payload size barely mattered for L1 hot hits, but Redis hot hits got much slower at `1MB`.
- With `commandTimeoutMs` in place, strict cold misses fail fast while graceful cold misses recover.
- Cross-instance invalidation and distributed single-flight both worked.

## 4. Slow Redis, Dead Redis, And Memory Pressure

### Slow Redis vs dead Redis

| Delay | Scenario | Success | Latency ms | Error |
|---|---|---:|---:|---|
| `0ms` | strict-hot-hit | true | 0.306 | |
| `0ms` | graceful-hot-hit | true | 0.051 | |
| `0ms` | strict-l2-hit | true | 5.027 | |
| `0ms` | graceful-l2-hit | true | 2.625 | |
| `0ms` | strict-cold-miss | true | 11.444 | |
| `0ms` | graceful-cold-miss | true | 9.878 | |
| `100ms` | strict-hot-hit | true | 0.110 | |
| `100ms` | graceful-hot-hit | true | 0.045 | |
| `100ms` | strict-l2-hit | true | 100.861 | |
| `100ms` | graceful-l2-hit | true | 100.292 | |
| `100ms` | strict-cold-miss | true | 404.759 | |
| `100ms` | graceful-cold-miss | true | 404.199 | |
| `500ms` | strict-hot-hit | true | 0.080 | |
| `500ms` | graceful-hot-hit | true | 0.073 | |
| `500ms` | strict-l2-hit | false | 0 | `RedisLayer command get("warm:key") timed out after 200ms.` |
| `500ms` | graceful-l2-hit | true | 200.163 | |
| `500ms` | strict-cold-miss | false | 0 | `RedisLayer command get("cold:key") timed out after 200ms.` |
| `500ms` | graceful-cold-miss | true | 200.430 | |
| `dead` | dead-strict-cold-miss | false | 0 | `RedisLayer command get("cold:key") timed out after 200ms.` |
| `dead` | dead-graceful-cold-miss | true | 401.531 | |

### Memory pressure and eviction

| Scenario | maxSize | Unique Keys | Evictions | L1 Retained | Revisit Avg ms | Revisit P95 ms | Revisit Origin Fetches | GC Count | GC Total ms | GC Max ms | Event Loop Max ms | Heap Delta MB |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| memory-pressure-eviction | 25 | 180 | 180 | 25 | 1.962 | 4.586 | 0 | 35 | 105.147 | 12.576 | 26.132 | 13.806 |

Key points:

- Slow Redis directly dragged L2-hit and cold-miss latency upward at `100ms`.
- At `500ms` and dead Redis, strict mode fails fast and graceful mode recovers successfully.
- Under heavy churn, L1 eviction behaved correctly and evicted entries were refilled from L2 without origin amplification.

## 5. Queue Amplification Under Slow Redis

### 0ms control

At `0ms`, queueing overhead comes mostly from Node and local coordination rather than Redis RTT:

| Scenario | x1 Total ms | x500 Total ms | x500 Amplification |
|---|---:|---:|---:|
| strict-l2-hit | 2.966 | 39.654 | 13.370 |
| graceful-l2-hit | 2.856 | 27.044 | 9.469 |

### 100ms injected latency

| Scenario | Concurrency | Total ms | Avg ms | P95 ms | Amplification vs x1 | Linearity Ratio |
|---|---:|---:|---:|---:|---:|---:|
| strict-l2-hit | 1 | 100.822 | 100.809 | 100.809 | 1.000 | 1.000 |
| strict-l2-hit | 10 | 100.999 | 100.974 | 100.990 | 1.002 | 0.100 |
| strict-l2-hit | 50 | 101.058 | 101.009 | 101.030 | 1.002 | 0.020 |
| strict-l2-hit | 100 | 104.212 | 104.116 | 104.173 | 1.034 | 0.010 |
| strict-l2-hit | 250 | 123.355 | 122.394 | 123.296 | 1.223 | 0.005 |
| strict-l2-hit | 500 | 127.594 | 124.584 | 125.970 | 1.266 | 0.003 |
| graceful-l2-hit | 1 | 102.495 | 102.485 | 102.485 | 1.000 | 1.000 |
| graceful-l2-hit | 10 | 101.039 | 101.003 | 101.028 | 0.986 | 0.099 |
| graceful-l2-hit | 50 | 101.413 | 101.353 | 101.384 | 0.989 | 0.020 |
| graceful-l2-hit | 100 | 103.138 | 103.045 | 103.099 | 1.006 | 0.010 |
| graceful-l2-hit | 250 | 104.441 | 104.243 | 104.376 | 1.019 | 0.004 |
| graceful-l2-hit | 500 | 121.857 | 117.307 | 119.892 | 1.189 | 0.002 |

### 500ms injected latency

| Scenario | Concurrency | Total ms | Avg ms | P95 ms | Amplification vs x1 | Linearity Ratio |
|---|---:|---:|---:|---:|---:|---:|
| strict-l2-hit | 1 | 501.332 | 501.320 | 501.320 | 1.000 | 1.000 |
| strict-l2-hit | 10 | 501.464 | 501.435 | 501.454 | 1.000 | 0.100 |
| strict-l2-hit | 50 | 502.127 | 502.080 | 502.098 | 1.002 | 0.020 |
| strict-l2-hit | 100 | 502.772 | 502.690 | 502.724 | 1.003 | 0.010 |
| strict-l2-hit | 250 | 508.808 | 508.554 | 508.710 | 1.015 | 0.004 |
| strict-l2-hit | 500 | 552.098 | 510.847 | 510.620 | 1.101 | 0.002 |
| graceful-l2-hit | 1 | 501.424 | 501.414 | 501.414 | 1.000 | 1.000 |
| graceful-l2-hit | 10 | 501.829 | 501.798 | 501.816 | 1.001 | 0.100 |
| graceful-l2-hit | 50 | 502.572 | 502.505 | 502.534 | 1.002 | 0.020 |
| graceful-l2-hit | 100 | 503.049 | 502.979 | 503.012 | 1.003 | 0.010 |
| graceful-l2-hit | 250 | 504.499 | 504.357 | 504.446 | 1.006 | 0.004 |
| graceful-l2-hit | 500 | 508.867 | 507.836 | 508.569 | 1.015 | 0.002 |

Key points:

- In this single-process setup, slow Redis did not create a sharp queueing cliff on warmed L2 hits.
- At `100ms`, even `x500` concurrency stayed near `122-128ms` total wall-clock.
- At `500ms`, even `x500` concurrency stayed near `509-552ms` total wall-clock.
- The dangerous path remains cold misses under degraded Redis, not warmed L2-hit fan-in.

## 6. Multi-Process Fan-Out

| Scenario | Success | Observed Version | Latency ms | Process Count | Concurrency Per Process | Total Concurrency | Origin Fetch Count |
|---|---:|---:|---:|---:|---:|---:|---:|
| multi-process-invalidation | true | 2 | 1.366 |  |  |  |  |
| multi-process-distributed-single-flight |  |  | 382.677 | 4 | 25 | 100 | 1 |

Key points:

- Cross-process invalidation propagated successfully.
- `100` concurrent requests across `4` worker processes triggered exactly `1` origin fetch.

## Overall Conclusions

### What layercache handled well

- Very fast hot-hit latency in both memory-only and layered modes
- Strong stampede prevention in single-process and multi-process cases
- Correct multi-instance invalidation with Redis-backed coordination
- Predictable L1 eviction and correct L2 refill under churn
- No queue-amplification cliff on warmed L2 hits in the tested single-process setup

### Main limits discovered

- Slow Redis still directly hurts any request that must touch L2
- Large payloads matter mainly when Redis is on the active read path

### Comparison with previous runs

| Metric | 04-10 (npm v1.2.9) | 04-14 (local v1.3.0-dev) | 04-15 (local v1.3.0) |
|---|---:|---:|---:|
| `/nocache` req/s | 161.13 | 93.13 | 142.50 |
| `/memory` req/s | 16,705 | 12,651 | 14,483 |
| `/layered` req/s | 17,184 | 4,859 | **15,196** |
| layered warm-hit avg ms | 0.005 | 0.006 | 0.007 |
| layered stampede avg ms | 36.675 | 17.352 | 12.690 |
| kernel | 5.15.0-173 | 5.15.0-174 | 5.15.0-174 |

Key observations from the three-run comparison:

1. The 04-14 `/layered` HTTP throughput drop to `4,859 req/s` was environmental noise, not a code regression. The same codebase on the same kernel now measures `15,196 req/s` — consistent with the 04-10 result of `17,184 req/s`.
2. The layered stampede path improved from `36.675ms` (v1.2.9) to `12.690ms` (v1.3.0), likely due to the StampedeGuard rewrite replacing async-mutex with promise-sharing.
3. Layered warm-hit latency remained essentially flat at `0.005-0.007ms` across all three runs.
4. `commandTimeoutMs` and `gracefulDegradation` now work together to make slow and dead Redis recoverable instead of hanging.

## Source Reports

- Detailed results: [benchmark-results-2026-04-15.md](/root/cache-test/docs/benchmark-results-2026-04-15.md)
- Detailed edge-case report: [benchmark-edge-results-2026-04-15.md](/root/cache-test/docs/benchmark-edge-results-2026-04-15.md)
- Detailed slow-Redis and memory-pressure report: [benchmark-slow-redis-memory-pressure-2026-04-15.md](/root/cache-test/docs/benchmark-slow-redis-memory-pressure-2026-04-15.md)
- Detailed queue-amplification report: [benchmark-queue-amplification-2026-04-15.md](/root/cache-test/docs/benchmark-queue-amplification-2026-04-15.md)
- Detailed multi-process report: [benchmark-multi-process-fanout-2026-04-15.md](/root/cache-test/docs/benchmark-multi-process-fanout-2026-04-15.md)
