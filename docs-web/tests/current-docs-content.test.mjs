import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

async function readDoc(relativePath) {
  return readFile(resolve(__dirname, "..", relativePath), "utf8");
}

test("CLI docs describe current scan limits, TLS behavior, and tag-index migration", async () => {
  const source = await readDoc("content/docs/cli.mdx");

  assert.match(source, /migrate-tag-index/);
  assert.match(source, /--known-key-shards/);
  assert.match(source, /--limit/);
  assert.match(source, /100,000 keys/);
  assert.match(source, /--allow-plaintext/);
  assert.match(source, /NODE_ENV=production/);
  assert.doesNotMatch(source, /1,000,000 keys/);
  assert.doesNotMatch(source, /1000000 keys/);
});

test("distributed docs describe signed invalidation messages and 16 tag-index shards", async () => {
  const source = await readDoc("content/docs/distributed.mdx");

  assert.match(source, /signingSecret/);
  assert.match(source, /HMAC-SHA256/);
  assert.match(source, /Default: 16 shards/);
  assert.match(source, /migrate-tag-index/);
  assert.doesNotMatch(source, /Default: 1 shard/);
});

test("integration docs describe HTTP cache safety behavior", async () => {
  const source = await readDoc("content/docs/integrations.mdx");

  assert.match(source, /Only 2xx JSON responses are written to the cache/);
  assert.match(source, /context\.status\(500\)/);
  assert.match(source, /bypass implicit caching/);
  assert.match(source, /api_key/);
  assert.match(source, /private_key/);
  assert.match(source, /credentials/);
});

test("API docs describe adaptive TTL process-local counters", async () => {
  const source = await readDoc("content/docs/api.mdx");

  assert.match(source, /Adaptive TTL counters are process-local/);
  assert.match(source, /multi-instance deployments/);
  assert.match(source, /shared Redis counter/);
});

test("API docs describe generation persistence and context-aware entry options", async () => {
  const source = await readDoc("content/docs/api.mdx");

  assert.match(source, /RedisGenerationStore/);
  assert.match(source, /const nextGeneration = await generations\.bump\(\)/);
  assert.match(source, /cache\.bumpGeneration\(nextGeneration\)/);
  assert.match(source, /Context-Aware Entry Options/);
  assert.match(source, /contextOptions: \(\{ value \}\)/);
});

test("API docs describe v4 miss/null semantics and new resilience options", async () => {
  const source = await readDoc("content/docs/api.mdx");

  assert.match(source, /cache\.getEntry/);
  assert.match(source, /Promise<T \| undefined>/);
  assert.match(source, /`cacheNullValues` \| `boolean` \| `true`/);
  assert.match(source, /CircuitBreakerOptions/);
  assert.match(source, /breakerKey/);
  assert.match(source, /RateLimitOptions/);
  assert.match(source, /queueOverflow/);
  assert.match(source, /maxWriteQueueDepth/);
});

test("web docs describe shared circuit breakers, queue overflow, disk queue guards, and metric capture", async () => {
  const resilience = await readDoc("content/docs/resilience.mdx");
  const layers = await readDoc("content/docs/layers.mdx");
  const observability = await readDoc("content/docs/observability.mdx");

  assert.match(resilience, /scope:\s*['"]shared['"]/);
  assert.match(resilience, /queueOverflow:\s*['"]bypass['"]/);
  assert.match(layers, /maxWriteQueueDepth/);
  assert.match(layers, /allowLegacyPlaintext/);
  assert.match(observability, /captureMetrics/);
  assert.match(observability, /layercache\.key_hash/);
});

test("docs are configured for GitHub Pages deployment", async () => {
  const robots = await readDoc("content/public/robots.txt");
  const config = await readFile(resolve(__dirname, "../rspress.config.ts"), "utf8");

  assert.match(robots, /https:\/\/layercache\.flyingsquirrel\.me\/sitemap\.xml/);
  assert.match(config, /GITHUB_PAGES/);
  assert.match(config, /\/layercache\//);
});
