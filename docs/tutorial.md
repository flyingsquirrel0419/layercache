# Tutorial: Getting Started with layercache

A step-by-step guide to setting up and operating layercache in production.

> [Back to README](../README.md)

---

## Table of Contents

1. [Create a Cache Stack](#1-create-a-cache-stack)
2. [Basic Read-Through Caching](#2-basic-read-through-caching)
3. [Warm Critical Keys at Startup](#3-warm-critical-keys-at-startup)
4. [Wrap Service Methods](#4-wrap-service-methods)
5. [Use Namespaces for Organization](#5-use-namespaces-for-organization)
6. [Set Up Tag-Based Invalidation](#6-set-up-tag-based-invalidation)
7. [Configure Stale Serving](#7-configure-stale-serving)
8. [Add Resilience](#8-add-resilience)
9. [Monitor with Stats & Metrics](#9-monitor-with-stats--metrics)
10. [Snapshot Before Deploys](#10-snapshot-before-deploys)

---

## 1. Create a Cache Stack

Start with a two-layer setup: fast in-memory L1 and shared Redis L2.

```ts
import { CacheStack, MemoryLayer, RedisLayer } from 'layercache'
import Redis from 'ioredis'

const cache = new CacheStack([
  new MemoryLayer({ ttl: 60_000, maxSize: 5_000 }),
  new RedisLayer({
    client: new Redis(),
    ttl: 300_000,
    prefix: 'myapp:cache:',
    compression: 'gzip'
  })
], {
  gracefulDegradation: { retryAfterMs: 10_000 },
  stampedePrevention: true  // on by default
})
```

**Why this setup?**
- Memory (L1) handles repeated reads with ~0.01ms latency
- Redis (L2) provides shared state across instances with ~0.5ms latency
- Compression reduces Redis memory usage for large values
- Graceful degradation keeps the cache working even if Redis goes down

---

## 2. Basic Read-Through Caching

The simplest pattern: fetch on miss, cache automatically.

```ts
// Fetcher runs once on miss, result fills all layers
const user = await cache.get<User>('user:123', () => db.findUser(123))

// Subsequent calls hit L1 (memory) - no DB or Redis call
const sameUser = await cache.get<User>('user:123')
```

With options:

```ts
const user = await cache.get<User>('user:123', () => db.findUser(123), {
  ttl: { memory: 30_000, redis: 600_000 },  // short L1, longer L2
  tags: ['user', 'user:123'],       // for bulk invalidation later
  ttlJitter: 5                      // prevent synchronized expiry
})
```

---

## 3. Warm Critical Keys at Startup

Pre-populate the cache before traffic arrives:

```ts
await cache.warm(
  [
    { key: 'config:flags',    fetcher: () => fetchFlags(),    priority: 10 },
    { key: 'catalog:top-100', fetcher: () => fetchCatalog(),  priority: 5 },
    { key: 'pricing:matrix',  fetcher: () => fetchPricing(),  priority: 5 },
  ],
  { concurrency: 4, continueOnError: true }
)
```

Higher `priority` values load first. `continueOnError` ensures one failed fetch doesn't block the rest.

---

## 4. Wrap Service Methods

Turn any async function into a cached function with automatic key derivation:

```ts
const getUser = cache.wrap('user', (id: number) => db.findUser(id), {
  ttl: 60_000,
  tags: ['users']
})

// Calls are automatically cached with key "user:123"
const user = await getUser(123)
```

With a custom key resolver:

```ts
const searchProducts = cache.wrap(
  'search',
  (query: string, page: number) => db.search(query, page),
  { keyResolver: (query, page) => `${query}:p${page}`, ttl: 30_000 }
)
```

---

## 5. Use Namespaces for Organization

Scope cache operations to avoid key collisions:

```ts
const users = cache.namespace('users')
const posts = cache.namespace('posts')

await users.set('123', userData)   // stored as "users:123"
await posts.set('456', postData)   // stored as "posts:456"

// Clear only user cache
await users.clear()                // deletes "users:*" only

// Nested namespaces for multi-tenancy
const tenant = cache.namespace('tenant:acme')
const tenantUsers = tenant.namespace('users')
await tenantUsers.set('1', data)   // stored as "tenant:acme:users:1"
```

---

## 6. Set Up Tag-Based Invalidation

Tag keys when writing, invalidate groups when data changes:

```ts
// Tag related data together
await cache.set('user:123',         user,    { tags: ['user:123'] })
await cache.set('user:123:posts',   posts,   { tags: ['user:123', 'posts'] })
await cache.set('user:123:profile', profile, { tags: ['user:123'] })

// When user 123 updates their profile, invalidate everything related
await cache.invalidateByTag('user:123')
// All three keys are deleted across all layers

// Batch invalidation
await cache.invalidateByTags(['users', 'posts'], 'any')   // either tag
await cache.invalidateByTags(['tenant:a', 'users'], 'all') // both tags
```

For multi-instance deployments, use `RedisTagIndex` so all servers share the same tag state:

```ts
import { RedisTagIndex } from 'layercache'

const tagIndex = new RedisTagIndex({ client: redis, prefix: 'myapp:tags' })
const cache = new CacheStack([...], { tagIndex })
```

---

## 7. Configure Stale Serving

Keep serving cached data even after expiry while refreshing in the background:

```ts
const config = await cache.get('app:config', fetchConfig, {
  ttl: 60_000,
  staleWhileRevalidate: 30_000,  // serve stale for 30s while refreshing
  staleIfError: 300_000           // serve stale for 5min if refresh fails
})
```

Combined with **refresh-ahead** to proactively refresh before expiry:

```ts
const leaderboard = await cache.get('leaderboard', fetchLeaderboard, {
  ttl: 120_000,
  refreshAhead: 30_000    // start refreshing when <= 30s remain
})
```

---

## 8. Add Resilience

Protect your app from cascading failures:

```ts
const cache = new CacheStack([...], {
  // Skip failed layers temporarily
  gracefulDegradation: { retryAfterMs: 10_000 },

  // Stop hammering broken upstreams
  circuitBreaker: { failureThreshold: 5, cooldownMs: 30_000 },

  // Rate limit fetcher calls
  fetcherRateLimit: { maxConcurrent: 10 },

  // Don't fail writes if one layer is down
  writePolicy: 'best-effort'
})
```

---

## 9. Monitor with Stats & Metrics

### Quick stats check

```ts
const stats = cache.getStats()
console.log(stats.metrics)  // { hits, misses, fetches, staleHits, ... }
console.log(stats.layers)   // [{ name, isLocal, degradedUntil }]
```

### HTTP stats endpoint

```ts
import { createCacheStatsHandler } from 'layercache'

app.get('/cache/stats', createCacheStatsHandler(cache))
```

### Health checks

```ts
const health = await cache.healthCheck()
// [{ layer: 'memory', healthy: true, latencyMs: 0.03 },
//  { layer: 'redis',  healthy: true, latencyMs: 0.41 }]
```

### Event-based monitoring

```ts
cache.on('hit',   ({ key, layer }) => metrics.inc('cache.hit', { layer }))
cache.on('miss',  ({ key })        => metrics.inc('cache.miss'))
cache.on('error', ({ event, ctx }) => logger.error(event, ctx))
```

### Admin CLI

```bash
npx layercache stats --redis redis://localhost:6379
npx layercache keys  --redis redis://localhost:6379 --pattern "user:*"
```

---

## 10. Snapshot Before Deploys

Save cache state before restarting:

```ts
// Before shutdown
await cache.persistToFile('./cache-snapshot.json')

// After restart
await cache.restoreFromFile('./cache-snapshot.json')
```

Or transfer between instances in-memory:

```ts
const snapshot = await cache.exportState()
await anotherCache.importState(snapshot)
```

---

## Next Steps

- [API Reference](./api.md) - Full API documentation
- [Migration Guide](./migration-guide.md) - Switching from another library
- [Comparison](./comparison.md) - Feature comparison with alternatives
- [Benchmarking](./benchmarking.md) - Performance measurement guide

> [Back to README](../README.md)
