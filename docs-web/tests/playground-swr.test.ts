import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createPlaygroundCache } from "../lib/playground/mock-layers.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

const delay = (ms: number) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));

test("playground cache serves stale values while a background refresh updates the entry", async () => {
  const logs: string[] = [];
  const { cache } = createPlaygroundCache((message) => logs.push(message));
  let fetchCount = 0;

  const first = await cache.get(
    "dashboard:metrics",
    async () => {
      fetchCount++;
      return { version: 1 };
    },
    { ttl: 10, staleWhileRevalidate: 1_000 }
  );

  assert.deepEqual(first, { version: 1 });
  await delay(40);

  const stale = await cache.get(
    "dashboard:metrics",
    async () => {
      fetchCount++;
      await delay(10);
      return { version: 2 };
    },
    { ttl: 1_000, staleWhileRevalidate: 1_000 }
  );

  assert.deepEqual(stale, { version: 1 });
  assert.equal(fetchCount, 2);

  await delay(70);

  const refreshed = await cache.get("dashboard:metrics");

  assert.deepEqual(refreshed, { version: 2 });
  assert.ok(logs.some((message) => message.includes("[SWR] Serving stale")));
});

test("playground cache supports exact-key invalidation aliases", async () => {
  const { cache } = createPlaygroundCache();

  await cache.set("user:1", { name: "Alice" });
  await cache.set("user:1:posts", [{ id: 1 }]);
  await cache.set("user:2", { name: "Bob" });

  await cache.invalidateByKey("user:1");

  assert.equal(await cache.get("user:1"), null);
  assert.deepEqual(await cache.get("user:1:posts"), [{ id: 1 }]);
  assert.deepEqual(await cache.get("user:2"), { name: "Bob" });

  await cache.invalidateByKeys(["user:1:posts", "user:2"]);

  assert.equal(await cache.get("user:1:posts"), null);
  assert.equal(await cache.get("user:2"), null);
});

test("playground cache supports exact-key expiration while serving stale values", async () => {
  const { cache } = createPlaygroundCache();
  let fetchCount = 0;

  await cache.set("profile:1", { version: 1 }, { ttl: 1_000, staleWhileRevalidate: 1_000 });

  await cache.expireByKey("profile:1");

  const stale = await cache.get(
    "profile:1",
    async () => {
      fetchCount++;
      return { version: 2 };
    },
    { ttl: 1_000, staleWhileRevalidate: 1_000 }
  );

  assert.deepEqual(stale, { version: 1 });
  assert.equal(fetchCount, 1);

  await delay(50);

  assert.deepEqual(await cache.get("profile:1"), { version: 2 });

  await cache.set("profile:2", { version: 1 }, { ttl: 1_000, staleWhileRevalidate: 1_000 });
  await cache.set("profile:3", { version: 1 }, { ttl: 1_000, staleWhileRevalidate: 1_000 });
  await cache.expireByKeys(["profile:2", "profile:3"]);

  assert.deepEqual(await cache.get("profile:2"), { version: 1 });
  assert.deepEqual(await cache.get("profile:3"), { version: 1 });
});

test("SWR playground preset uses millisecond TTL options and demonstrates stale then refreshed data", async () => {
  const presetsPath = resolve(__dirname, "../lib/playground/presets.ts");
  const source = await readFile(presetsPath, "utf8");
  const swrPreset = source.match(/id: "swr",[\s\S]*?(?=\n  \},\n  \{)/)?.[0] ?? "";

  assert.match(swrPreset, /ttl:\s*1_000/);
  assert.match(swrPreset, /staleWhileRevalidate:\s*10_000/);
  assert.doesNotMatch(swrPreset, /\},\s*10\);/);
  assert.match(swrPreset, /Stale hit while refresh runs/);
  assert.match(swrPreset, /Fresh after revalidate/);
});

test("playground presets include exact-key invalidation and expiration syntax", async () => {
  const presetsPath = resolve(__dirname, "../lib/playground/presets.ts");
  const source = await readFile(presetsPath, "utf8");

  assert.match(source, /invalidateByKey\("user:1"\)/);
  assert.match(source, /invalidateByKeys\(\["user:1:posts", "user:2"\]\)/);
  assert.match(source, /expireByKey\("profile:1"\)/);
  assert.match(source, /expireByKeys\(\["profile:2", "profile:3"\]\)/);
});

test("playground presets include current null-entry and shared circuit breaker syntax", async () => {
  const presetsPath = resolve(__dirname, "../lib/playground/presets.ts");
  const source = await readFile(presetsPath, "utf8");

  assert.match(source, /cacheNullValues:\s*true/);
  assert.match(source, /cache\.getEntry\("profile:deleted"\)/);
  assert.match(source, /negativeCache:\s*true/);
  assert.match(source, /scope:\s*"shared"/);
  assert.match(source, /breakerKey:\s*"users-api"/);
});

test("playground presets use current write options for tags instead of cache.tag()", async () => {
  const presetsPath = resolve(__dirname, "../lib/playground/presets.ts");
  const source = await readFile(presetsPath, "utf8");

  assert.match(source, /tags:\s*\["products", "catalog"\]/);
  assert.doesNotMatch(source, /cache\.tag\(/);
});

test("playground cache supports shouldCache and null misses", async () => {
  const { cache } = createPlaygroundCache();
  let attempts = 0;

  const failed = await cache.get(
    "http:profile",
    async ({ state }) => {
      attempts++;
      assert.equal(state, "miss");
      return { ok: false };
    },
    { ttl: 1_000, shouldCache: (value) => (value as { ok: boolean }).ok }
  );

  assert.deepEqual(failed, { ok: false });
  assert.equal(await cache.get("http:profile"), null);

  const successful = await cache.get(
    "http:profile",
    async () => {
      attempts++;
      return { ok: true };
    },
    { ttl: 1_000, shouldCache: (value) => (value as { ok: boolean }).ok }
  );

  assert.deepEqual(successful, { ok: true });
  assert.deepEqual(await cache.get("http:profile"), { ok: true });
  assert.equal(attempts, 2);
});

test("playground cache distinguishes stored nulls from negative-cache entries and misses", async () => {
  const { cache } = createPlaygroundCache();

  await cache.set("profile:deleted", null, { ttl: 1_000, cacheNullValues: true });
  assert.equal(await cache.get("profile:deleted"), null);
  const deletedEntry = await cache.getEntry("profile:deleted");
  assert.equal(typeof deletedEntry?.layer, "string");
  assert.deepEqual(
    deletedEntry && {
      key: deletedEntry.key,
      value: deletedEntry.value,
      kind: deletedEntry.kind,
      state: deletedEntry.state,
    },
    {
      key: "profile:deleted",
      value: null,
      kind: "value",
      state: "fresh",
    }
  );

  await cache.get("profile:not-found", async () => null, { ttl: 1_000, negativeCache: true });
  assert.equal(await cache.get("profile:not-found"), null);
  const negativeEntry = await cache.getEntry("profile:not-found");
  assert.equal(typeof negativeEntry?.layer, "string");
  assert.deepEqual(
    negativeEntry && {
      key: negativeEntry.key,
      value: negativeEntry.value,
      kind: negativeEntry.kind,
      state: negativeEntry.state,
    },
    {
      key: "profile:not-found",
      value: null,
      kind: "empty",
      state: "fresh",
    }
  );
  assert.equal(await cache.getEntry("profile:missing"), null);
});

test("playground cache applies shared circuit breaker options", async () => {
  const { cache } = createPlaygroundCache();
  const circuitBreaker = { failureThreshold: 2, cooldownMs: 60_000, scope: "shared" as const, breakerKey: "users-api" };
  let attempts = 0;

  for (const key of ["user:1", "user:2"]) {
    await assert.rejects(
      cache.get(
        key,
        async () => {
          attempts++;
          throw new Error("down");
        },
        { circuitBreaker }
      ),
      /down/
    );
  }

  await assert.rejects(cache.get("user:3", async () => "ok", { circuitBreaker }), /Circuit breaker is open/);
  assert.equal(attempts, 2);
});

test("playground cache supports generation rotation", async () => {
  const { cache } = createPlaygroundCache({ generation: 1 });

  await cache.set("user:1", { version: 1 });
  assert.equal(cache.getGeneration(), 1);
  assert.deepEqual(await cache.get("user:1"), { version: 1 });

  const nextGeneration = cache.bumpGeneration();

  assert.equal(nextGeneration, 2);
  assert.equal(cache.getGeneration(), 2);
  assert.equal(await cache.get("user:1"), null);

  await cache.set("user:1", { version: 2 });
  assert.deepEqual(await cache.get("user:1"), { version: 2 });
});

test("playground cache backfills missed upper layers from a lower-layer hit", async () => {
  const logs: string[] = [];
  const { cache, layers } = createPlaygroundCache({ onLog: (message) => logs.push(message) });

  await layers.redis.set("catalog:item:1", { id: 1 }, 1_000);

  assert.equal(await layers.memory.get("catalog:item:1"), undefined);
  assert.deepEqual(await cache.get("catalog:item:1"), { id: 1 });
  assert.deepEqual(await layers.memory.get("catalog:item:1"), { id: 1 });
  assert.ok(logs.some((message) => message.includes("Filled 1 upper layer")));
});

test("playground presets include generation and parallel backfill examples", async () => {
  const presetsPath = resolve(__dirname, "../lib/playground/presets.ts");
  const source = await readFile(presetsPath, "utf8");

  assert.match(source, /id: "generation"/);
  assert.match(source, /cache\.getGeneration\(\)/);
  assert.match(source, /cache\.bumpGeneration\(\)/);
  assert.match(source, /id: "parallel-backfill"/);
  assert.match(source, /layers\.redis\.set\("catalog:item:1"/);
});
