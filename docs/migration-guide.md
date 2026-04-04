# Migration Guide

## From node-cache-manager

1. Replace `cache.wrap(key, fn)` with `cache.get(key, fn)`.
2. Replace per-store TTL with `ttl` or `LayerTtlMap`.
3. Replace manual invalidation lists with `tags` or `invalidateByPattern`.

```ts
const cache = new CacheStack([
  new MemoryLayer({ ttl: 60 }),
  new RedisLayer({ client: redis, ttl: 300 })
])
```

## From keyv

1. Move your Redis client into `RedisLayer`.
2. Keep memory as the first layer for hot-path reads.
3. Use `cache.wrap()` for function caching.

## Operational migration

- Replace ad-hoc Redis key scans with `layercache keys --redis <url>`.
- Replace manual prefill scripts with `cache.warm(...)`.
- Replace custom stats endpoints with `createCacheStatsHandler(cache)`.
