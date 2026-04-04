# Operational Tutorial

## 1. Create a cache stack

```ts
const cache = new CacheStack([
  new MemoryLayer({ ttl: 60, maxSize: 5_000 }),
  new RedisLayer({ client: redis, ttl: 300, compression: 'gzip' })
], {
  gracefulDegradation: { retryAfterMs: 10_000 },
  adaptiveTtl: { hotAfter: 3, step: 30, maxTtl: 300 }
})
```

## 2. Warm critical keys

```ts
await cache.warm([
  { key: 'config:flags', fetcher: () => fetchFlags(), priority: 10 },
  { key: 'catalog:top-100', fetcher: () => fetchCatalog() }
])
```

## 3. Wrap a service method

```ts
const getUser = cache.wrap('user', fetchUser, { ttl: 60, tags: ['users'] })
```

## 4. Expose stats

```ts
app.get('/cache/stats', createCacheStatsHandler(cache))
```

## 5. Snapshot before deploy

```ts
await cache.persistToFile('./cache-snapshot.json')
```

## 6. Restore after restart

```ts
await cache.restoreFromFile('./cache-snapshot.json')
```
