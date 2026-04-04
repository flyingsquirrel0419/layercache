# Benchmarking

## Included benchmarks

- `npm run bench:latency`
- `npm run bench:stampede`

## Recommended scenarios

1. L1 hit latency with memory only.
2. L2 hit latency with Redis backfill.
3. Full miss latency with single-flight enabled.
4. Warm-start latency after `cache.warm(...)`.
5. Redis payload size with and without compression.

## Reporting format

- Node version
- Redis version
- CPU and memory profile
- Layer configuration
- Average latency, p95, p99
- Fetcher execution count under concurrency
