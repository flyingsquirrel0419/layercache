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
  assert.match(source, /api_key/);
  assert.match(source, /private_key/);
  assert.match(source, /credentials/);
});
