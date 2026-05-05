export type Preset = {
  id: string;
  title: string;
  description: string;
  code: string;
};

export const presets: Preset[] = [
  {
    id: "basic",
    title: "Basic Get/Set",
    description: "Simple cache read-through pattern",
    code: `// Basic get/set operations
const { cache } = createPlaygroundCache();

// Set a value
await cache.set("user:1", { name: "Alice", role: "admin" });
console.log("Set user:1");

// Get it back
const user = await cache.get("user:1");
console.log("Got user:", JSON.stringify(user));

// Check stats
console.log("Stats:", JSON.stringify(cache.getStats()));`,
  },
  {
    id: "multi-layer",
    title: "Multi-Layer Stack",
    description: "See how data flows across memory, Redis, and disk",
    code: `// Multi-layer cache with backfill
const { cache, layers } = createPlaygroundCache();

const cacheOptions = { ttl: 120_000 };

// First request - cache miss, fetcher runs
const data = await cache.get("api:products", async () => {
  console.log("Fetcher called - fetching from database...");
  return [{ id: 1, name: "Widget" }, { id: 2, name: "Gadget" }];
}, cacheOptions);

console.log("Result:", JSON.stringify(data));

// Second request - cache hit
const cached = await cache.get("api:products");
console.log("Cached result:", JSON.stringify(cached));

// Check each layer
console.log("Layer info:", JSON.stringify(cache.getLayerInfo(), null, 2));`,
  },
  {
    id: "swr",
    title: "Stale-While-Revalidate",
    description: "Serve stale data while refreshing in background",
    code: `// Simulating stale-while-revalidate pattern
const { cache } = createPlaygroundCache();
let fetchCount = 0;
const cacheOptions = { ttl: 1_000, staleWhileRevalidate: 10_000 };

// Initial fetch
const data1 = await cache.get("dashboard:metrics", async () => {
  fetchCount++;
  console.log(\`Fetch #\${fetchCount}: Loading metrics...\`);
  return { views: 1250, users: 89, revenue: 45000 };
}, cacheOptions);
console.log("First load:", JSON.stringify(data1));

// Let the fresh TTL expire, but keep the stale window open
await new Promise(r => setTimeout(r, 1100));

// This returns stale data immediately while the refresh runs
const stale = await cache.get("dashboard:metrics", async ({ state, currentValue }) => {
  await new Promise(r => setTimeout(r, 150));
  fetchCount++;
  console.log(\`Fetch #\${fetchCount}: Refreshing from \${state} value \${JSON.stringify(currentValue)}...\`);
  return { views: 1300, users: 92, revenue: 47000 };
}, cacheOptions);
console.log("Stale hit while refresh runs:", JSON.stringify(stale));

// Wait for the background refresh, then read the updated value
await new Promise(r => setTimeout(r, 250));
const refreshed = await cache.get("dashboard:metrics");
console.log("Fresh after revalidate:", JSON.stringify(refreshed));

console.log("Total fetcher calls:", fetchCount);
console.log("Stats:", JSON.stringify(cache.getStats()));`,
  },
  {
    id: "tag-invalidation",
    title: "Tag Invalidation",
    description: "Invalidate cache entries by tag",
    code: `// Tag-based cache invalidation
const { cache } = createPlaygroundCache();

// Set values with write-time tags
await cache.set("product:1", { name: "Widget", price: 9.99 }, {
  ttl: 300_000,
  tags: ["products", "catalog"],
});

await cache.set("product:2", { name: "Gadget", price: 19.99 }, {
  ttl: 300_000,
  tags: ["products", "catalog"],
});

await cache.set("page:home", { title: "Home", layout: "full" }, {
  ttl: 300_000,
  tags: ["pages", "catalog"],
});

console.log("Before invalidation:");
console.log("Stats:", JSON.stringify(cache.getStats()));

// Invalidate all products
const removed = await cache.invalidateByTag("products");
console.log(\`\\nInvalidated \${removed} entries with tag "products"\`);

console.log("\\nAfter invalidation:");
console.log("Stats:", JSON.stringify(cache.getStats()));
console.log("Layer info:", JSON.stringify(cache.getLayerInfo()));`,
  },
  {
    id: "cache-policy",
    title: "Cache Policy",
    description: "Use shouldCache and fetcher context to avoid caching failed values",
    code: `// Conditional caching with current fetcher context
const { cache } = createPlaygroundCache();
let attempts = 0;

const options = {
  ttl: 30_000,
  shouldCache: (value) => value.ok === true,
};

const first = await cache.get("http:api:profile", async ({ key, state }) => {
  attempts++;
  console.log(\`Fetch #\${attempts} for \${key} after \${state}\`);
  return { ok: false, status: 500 };
}, options);

console.log("First result returned but not cached:", JSON.stringify(first));
console.log("Cached value after failed result:", await cache.get("http:api:profile"));

const second = await cache.get("http:api:profile", async ({ key }) => {
  attempts++;
  console.log(\`Fetch #\${attempts} for \${key}\`);
  return { ok: true, status: 200, name: "Alice" };
}, options);

console.log("Second result cached:", JSON.stringify(second));
console.log("Cached value now:", JSON.stringify(await cache.get("http:api:profile")));`,
  },
  {
    id: "exact-key-apis",
    title: "Exact-Key APIs",
    description: "Invalidate or expire individual keys without pattern matching",
    code: `// Exact-key invalidation and expiration
const { cache } = createPlaygroundCache();

await cache.set("user:1", { name: "Alice" });
await cache.set("user:1:posts", [{ id: 1, title: "Hello" }]);
await cache.set("user:2", { name: "Bob" });

await cache.invalidateByKey("user:1");
console.log("user:1 after invalidateByKey:", await cache.get("user:1"));
console.log("user:1:posts stays:", JSON.stringify(await cache.get("user:1:posts")));

await cache.invalidateByKeys(["user:1:posts", "user:2"]);
console.log("Keys after invalidateByKeys:", JSON.stringify(cache.getLayerInfo()[0].keys));

await cache.set("profile:1", { version: 1 }, { ttl: 60_000, staleWhileRevalidate: 60_000 });
await cache.expireByKey("profile:1");

const stale = await cache.get("profile:1", async () => {
  console.log("Refreshing profile:1 in background");
  return { version: 2 };
}, { ttl: 60_000, staleWhileRevalidate: 60_000 });
console.log("expireByKey served stale:", JSON.stringify(stale));

await cache.set("profile:2", { version: 1 }, { ttl: 60_000, staleWhileRevalidate: 60_000 });
await cache.set("profile:3", { version: 1 }, { ttl: 60_000, staleWhileRevalidate: 60_000 });
await cache.expireByKeys(["profile:2", "profile:3"]);
console.log("Expired multiple exact keys");`,
  },
  {
    id: "generation",
    title: "Generation Rotation",
    description: "Rotate cache generations and persist the active generation",
    code: `// Generation-based invalidation with a persisted generation value.
// In production, store this with RedisGenerationStore.
const persistedGeneration = { value: 1 };
const { cache } = createPlaygroundCache({ generation: persistedGeneration.value });

await cache.set("user:1", { version: 1 });
console.log("Current generation:", cache.getGeneration());
console.log("v1 read:", JSON.stringify(await cache.get("user:1")));

const nextGeneration = cache.bumpGeneration();
persistedGeneration.value = nextGeneration;
console.log("Persisted generation:", persistedGeneration.value);

console.log("After rotation, same logical key misses:", await cache.get("user:1"));

await cache.set("user:1", { version: 2 });
console.log("v2 read:", JSON.stringify(await cache.get("user:1")));
console.log("Layer keys:", JSON.stringify(cache.getLayerInfo()[0].keys));`,
  },
  {
    id: "parallel-backfill",
    title: "Parallel Backfill",
    description: "Fill missed upper layers from a lower-layer hit",
    code: `// Parallel backfill from a lower layer into faster upper layers
const { cache, layers } = createPlaygroundCache();

await layers.redis.set("catalog:item:1", { id: 1, name: "Widget" }, 120_000);
console.log("Seeded Redis only");
console.log("Before read:", JSON.stringify(cache.getLayerInfo(), null, 2));

const item = await cache.get("catalog:item:1", async () => {
  throw new Error("Fetcher should not run when Redis has the value");
}, { ttl: 120_000 });

console.log("Read result:", JSON.stringify(item));
console.log("After read:", JSON.stringify(cache.getLayerInfo(), null, 2));
console.log("Backfills:", cache.getStats().backfills);`,
  },
  {
    id: "namespaces",
    title: "Namespaces",
    description: "Organize cache with key prefixes",
    code: `// Namespace-like key organization
const { cache } = createPlaygroundCache();

// User namespace
await cache.set("users:1", { name: "Alice" });
await cache.set("users:2", { name: "Bob" });

// Session namespace
await cache.set("sessions:abc123", { userId: 1, expires: "2025-12-31" });
await cache.set("sessions:def456", { userId: 2, expires: "2025-12-31" });

// API namespace
await cache.set("api:/products", { items: [1, 2, 3] });

console.log("All cached:");
cache.getLayerInfo()[0].keys.forEach(k => console.log(\`  \${k}\`));

console.log("\\nStats:", JSON.stringify(cache.getStats()));`,
  },
  {
    id: "stampede",
    title: "Stampede Prevention",
    description: "Concurrent request deduplication",
    code: `// Simulating stampede prevention
const { cache } = createPlaygroundCache();
let fetchCount = 0;

async function fetchData(key) {
  return cache.get(key, async () => {
    fetchCount++;
    console.log(\`Fetcher #\${fetchCount} called for "\${key}"\`);
    // Simulate slow fetch
    await new Promise(r => setTimeout(r, 100));
    return { data: \`Result for \${key}\`, fetchedAt: Date.now() };
  }, { ttl: 60_000 });
}

// Fire 5 concurrent requests for the same key
console.log("Firing 5 concurrent requests...");
const results = await Promise.all([
  fetchData("hot:key"),
  fetchData("hot:key"),
  fetchData("hot:key"),
  fetchData("hot:key"),
  fetchData("hot:key"),
]);

console.log("\\nAll results identical:", results.every(r => JSON.stringify(r) === JSON.stringify(results[0])));
console.log("Fetcher called:", fetchCount, "time(s)");
console.log("Stats:", JSON.stringify(cache.getStats()));`,
  },
  {
    id: "circuit-breaker",
    title: "Circuit Breaker",
    description: "Failure threshold and recovery",
    code: `// Simulating circuit breaker behavior
const { cache } = createPlaygroundCache();
let attempts = 0;
let successes = 0;

console.log("Simulating failing fetcher...\\n");

// Attempt multiple fetches - simulate failures
for (let i = 0; i < 5; i++) {
  attempts++;
  try {
    const result = await cache.get(\`key:\${i}\`, async () => {
      if (i < 3) {
        console.log(\`  Attempt \${i + 1}: Fetcher FAILED\`);
        throw new Error("Database connection failed");
      }
      console.log(\`  Attempt \${i + 1}: Fetcher succeeded\`);
      return { value: \`data-\${i}\` };
    }, { ttl: 30_000 });
    successes++;
  } catch (e) {
    console.log(\`  -> Error caught (attempt \${i + 1})\`);
  }
}

console.log(\`\\nResults: \${successes}/\${attempts} successful\`);
console.log("Stats:", JSON.stringify(cache.getStats()));`,
  },
  {
    id: "write-behind",
    title: "Write-Behind",
    description: "Deferred writes with batch flush",
    code: `// Simulating write-behind pattern
const { cache } = createPlaygroundCache();
const writeQueue = [];

// Fast local write
async function setLocal(key, value) {
  await cache.set(key, value);
  writeQueue.push({ key, value });
  console.log(\`Queued write for "\${key}" (queue: \${writeQueue.length})\`);
}

// Batch flush to "remote" layers
async function flushWrites() {
  if (writeQueue.length === 0) return;
  console.log(\`\\nFlushing \${writeQueue.length} writes to remote...\`);
  const batch = [...writeQueue];
  writeQueue.length = 0;

  for (const entry of batch) {
    console.log(\`  Flushed: \${entry.key}\`);
  }
  console.log(\`Flushed \${batch.length} entries\`);
}

// Simulate rapid writes
await setLocal("user:1", { name: "Alice" });
await setLocal("user:2", { name: "Bob" });
await setLocal("user:3", { name: "Charlie" });

console.log("\\nCache stats before flush:");
console.log(JSON.stringify(cache.getStats()));

await flushWrites();

console.log("\\nFinal stats:", JSON.stringify(cache.getStats()));`,
  },
];
