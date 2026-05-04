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

  assert.equal(await cache.get("user:1"), undefined);
  assert.deepEqual(await cache.get("user:1:posts"), [{ id: 1 }]);
  assert.deepEqual(await cache.get("user:2"), { name: "Bob" });

  await cache.invalidateByKeys(["user:1:posts", "user:2"]);

  assert.equal(await cache.get("user:1:posts"), undefined);
  assert.equal(await cache.get("user:2"), undefined);
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
