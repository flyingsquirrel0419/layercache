# Migration Guide

Step-by-step instructions for migrating to layercache from other caching libraries.

> [Back to README](../README.md)

---

## Table of Contents

- [Unreleased security hardening](#unreleased-security-hardening)
- [Upgrading to 3.0](#upgrading-to-30)
- [From node-cache-manager](#from-node-cache-manager)
- [From keyv](#from-keyv)
- [From cacheable](#from-cacheable)
- [Operational Migration Tips](#operational-migration-tips)

---

## Unreleased security hardening

This release deliberately changes three cache and operator safety boundaries:

- Automatically derived structured `wrap()` argument keys now use the `j2:` schema. Existing `j:` entries are left to expire and will be cold misses; no data migration is required. Plain objects with reserved native `$type` tags (`Date`, `URL`, `RegExp`, `Map`, or `Set`) now throw instead of colliding with native values. Use a `keyResolver` when those objects are intentional inputs.
- `generationCleanup: true` now stops after discovering 10,000 unique old-generation keys in one cleanup run. Set `generationCleanup: { batchSize, maxMatches }` to choose a lower deployment-specific bound. `maxMatches: false` is an explicit opt-out and should only be used when the keyspace is bounded elsewhere.
- Write-through, write-behind, single-key, and `mset()` writes share finite ordering state. The defaults admit 10,000 pending key-write units, 10,000 active keys, and 1,000 pending operations per key. Tune `writeCoordination` for known bursts and handle `CacheWriteSaturationError` as backpressure rather than retrying without a limit.

Wildcard-only CLI invalidation patterns now all require `--force`, including combinations of `*` and `?` such as `**` and `?*`.

---

## Upgrading to 3.0

Layercache 3.0 is a major release because it changes a few operational defaults around Redis and HTTP cache keys.

### RedisTagIndex known-key shards

`RedisTagIndex` now defaults to 16 known-key shards. Existing deployments that used the older single-set layout at `<prefix>:keys` are still read for compatibility, but you should migrate before relying on the sharded layout in production:

```bash
npx layercache migrate-tag-index \
  --redis rediss://redis.example.com:6379 \
  --tag-index-prefix myapp:tag-index \
  --known-key-shards 16
```

Use `knownKeysShards: 1` only when you intentionally need the legacy layout during a staged rollout.

### Production Redis URLs in the CLI

CLI commands now reject plaintext `redis://` URLs when `NODE_ENV=production`, unless `--allow-plaintext` is passed:

```bash
NODE_ENV=production npx layercache stats --redis rediss://redis.example.com:6379
NODE_ENV=production npx layercache stats --redis redis://localhost:6379 --allow-plaintext
```

### Implicit HTTP cache keys

Express and Hono middleware now bypass implicit URL-only caching when common sensitive query parameters are present. This avoids both storing secrets in cache keys and collapsing private responses into one scrubbed URL key. Provide a custom `keyResolver` when private responses are selected by query credentials.

The sensitive parameter names are `access_token`, `api_key`, `apikey`, `auth`, `authorization`, `client_assertion`, `client_assertion_type`, `client_secret`, `code`, `credentials`, `id_token`, `jwt`, `password`, `private_key`, `refresh_token`, `secret`, `session`, `sessionid`, `session_id`, and `token`. The same list is documented in the integration options.

### DiskLayer protected entries

When `DiskLayer` is configured with `encryptionKey` or `signingKey`, plaintext legacy entries are now rejected by default. If you need to read old plaintext files during a migration, enable `allowLegacyPlaintext: true` temporarily and disable it after the cache directory has been rewritten.

### OpenTelemetry key attributes

`createOpenTelemetryPlugin()` now exports `layercache.key_hash` by default. Pass `{ includeRawKeyAttributes: true }` only if your telemetry backend is allowed to receive raw cache keys.

### Generation persistence

Persist generation rotations when several instances share the same cache:

```ts
import { CacheStack, RedisGenerationStore } from 'layercache'

const generations = new RedisGenerationStore({ client: redis })
const generation = await generations.getOrInitialize(1)
const cache = new CacheStack(layers, { generation })

const nextGeneration = await generations.bump()
cache.bumpGeneration(nextGeneration)
```

---

## From node-cache-manager

### Basic setup

**Before (node-cache-manager):**

```ts
import { caching, multiCaching } from 'cache-manager'
import { redisStore } from 'cache-manager-redis-yet'

const memoryCache = await caching('memory', { max: 100, ttl: 60 * 1000 })
const redisCache = await caching(redisStore, { url: 'redis://localhost:6379', ttl: 300 * 1000 })
const cache = multiCaching([memoryCache, redisCache])
```

**After (layercache):**

```ts
import { CacheStack, MemoryLayer, RedisLayer } from 'layercache'
import Redis from 'ioredis'

const cache = new CacheStack([
  new MemoryLayer({ ttl: 60_000, maxSize: 100 }),
  new RedisLayer({ client: new Redis(), ttl: 300_000 })
])
```

### API mapping

| node-cache-manager | layercache | Notes |
|---|---|---|
| `cache.wrap(key, fn)` | `cache.get(key, fn)` | Read-through fetch |
| `cache.set(key, val, ttl)` | `cache.set(key, val, { ttl })` | TTL in milliseconds |
| `cache.get(key)` | `cache.get(key)` | Same API |
| `cache.del(key)` | `cache.delete(key)` | Renamed |
| `cache.reset()` | `cache.clear()` | Renamed |
| Per-store TTL | `ttl: { memory: 60_000, redis: 300_000 }` | Per-layer TTL map |
| - | `cache.invalidateByTag(tag)` | New: tag invalidation |
| - | `cache.wrap(prefix, fn)` | New: transparent function caching |

### Key differences

- **TTL is in milliseconds**
- **Auto backfill** is built in - no manual L1 warming needed
- **Stampede prevention** is on by default
- **Tag invalidation** replaces manual key tracking for group deletion

---

## From keyv

### Basic setup

**Before (keyv):**

```ts
import Keyv from 'keyv'
import KeyvRedis from '@keyv/redis'

const keyv = new Keyv({ store: new KeyvRedis('redis://localhost:6379') })

await keyv.set('user:123', user, 60000)
const user = await keyv.get('user:123')
```

**After (layercache):**

```ts
import { CacheStack, MemoryLayer, RedisLayer } from 'layercache'

const cache = new CacheStack([
  new MemoryLayer({ ttl: 60_000 }),
  new RedisLayer({ client: new Redis(), ttl: 300_000 })
])

await cache.set('user:123', user, { ttl: 60_000 })
const user = await cache.get('user:123')
```

### API mapping

| keyv | layercache | Notes |
|---|---|---|
| `keyv.set(key, val, ttl)` | `cache.set(key, val, { ttl })` | TTL in milliseconds |
| `keyv.get(key)` | `cache.get(key)` | Same |
| `keyv.delete(key)` | `cache.delete(key)` | Same |
| `keyv.clear()` | `cache.clear()` | Same |
| Namespace via constructor | `cache.namespace(prefix)` | Scoped views |
| - | `cache.get(key, fetcher)` | New: read-through fetch |
| - | `cache.wrap(prefix, fn)` | New: function caching |

### Key differences

- **Multi-layer is native** - not a plugin. Reads cascade through layers with auto backfill.
- **Read-through fetch** - pass a fetcher to `get()` and the cache handles misses automatically.
- **TTL is in milliseconds.**
- **Namespaces** work the same way conceptually but return a full-featured `CacheNamespace`.

---

## From cacheable

### Basic setup

**Before (cacheable):**

```ts
import { Cacheable } from 'cacheable'

const cache = new Cacheable({ ttl: '1h' })
await cache.set('key', value)
```

**After (layercache):**

```ts
import { CacheStack, MemoryLayer } from 'layercache'

const cache = new CacheStack([
  new MemoryLayer({ ttl: 3_600_000 })
])
await cache.set('key', value)
```

### Key differences

- **TTL is numeric milliseconds** instead of string durations
- **Multi-layer orchestration** with auto backfill across any number of layers
- **Distributed consistency** via Redis pub/sub invalidation bus and shared tag index
- **Stampede prevention** built in
- **Richer invalidation** - tags, patterns, prefixes, and generation-based rotation

---

## Operational Migration Tips

### Replace ad-hoc Redis key scans

**Before:**

```bash
redis-cli --scan --pattern "user:*" | xargs redis-cli del
```

**After:**

```bash
npx layercache keys --redis redis://localhost:6379 --pattern "user:*"
npx layercache invalidate --redis redis://localhost:6379 --pattern "user:*"
```

### Replace manual prefill scripts

**Before:**

```ts
// Custom warm-up script
for (const key of criticalKeys) {
  const val = await fetch(key)
  await redis.set(key, JSON.stringify(val), 'EX', 300)
}
```

**After:**

```ts
await cache.warm(
  criticalKeys.map(key => ({
    key,
    fetcher: () => fetchByKey(key),
    priority: 10
  })),
  { concurrency: 4, continueOnError: true }
)
```

### Replace custom stats endpoints

**Before:**

```ts
app.get('/stats', (req, res) => {
  res.json({ hits: myCounter.hits, misses: myCounter.misses })
})
```

**After:**

```ts
import { createCacheStatsHandler } from 'layercache'

app.get('/cache/stats', createCacheStatsHandler(cache))
```

---

## Need Help?

If you run into issues during migration, [open an issue](https://github.com/flyingsquirrel0419/layercache/issues) with your current setup and we'll help you find the right approach.

> [Back to README](../README.md)
