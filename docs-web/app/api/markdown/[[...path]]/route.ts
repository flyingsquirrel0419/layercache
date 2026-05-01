import { NextRequest } from "next/server";
import fs from "fs";
import path from "path";
import { getAllDocs } from "@/lib/mdx";

export const dynamic = "force-static";

const contentDir = path.join(process.cwd(), "content/docs");

const HOME_MARKDOWN = `# Layercache

> Production-ready multi-layer caching for Node.js.

Layercache stacks memory, Redis, and disk behind a single API with single-flight
stampede prevention, tag invalidation, stale-while-revalidate, circuit breakers,
and full observability.

## Core Architecture

- **L1 Memory** — per-process, ~0.01 ms
- **L2 Redis** — shared across instances, ~0.5 ms
- **L3 Disk** — persistent, ~2 ms

On hit, the fastest available layer serves and backfills slower layers.
On miss, the fetcher runs exactly once even under 100+ concurrent callers.

## Install

\`\`\`bash
npm install layercache
\`\`\`

Requires Node.js >= 20.

## Example

\`\`\`ts
import { CacheStack, MemoryLayer, RedisLayer } from 'layercache'
import Redis from 'ioredis'

const cache = new CacheStack([
  new MemoryLayer({ ttl: 60_000, maxSize: 1_000 }),
  new RedisLayer({ client: new Redis(), ttl: 3_600_000, commandTimeoutMs: 50 }),
])

const user = await cache.get('user:123', () => db.findUser(123))
\`\`\`

## Key Features

- Single-flight deduplication (local + distributed via Redis leases)
- Tag-based, wildcard, and generation-based invalidation
- Stale-while-revalidate and stale-if-error
- Circuit breaker with graceful degradation when a layer fails
- OpenTelemetry tracing, Prometheus metrics, event hooks
- Framework middleware: Express, Fastify, Hono, tRPC, GraphQL, Next.js

## Discovery for Agents

- API catalog: \`/.well-known/api-catalog\`
- A2A Agent Card: \`/.well-known/agent-card.json\`
- MCP Server Card: \`/.well-known/mcp/server-card.json\`
- Agent skills index: \`/.well-known/agent-skills/index.json\`

## Links

- Docs: https://layercache.dev/docs
- API Reference: https://layercache.dev/docs/api
- Source: https://github.com/flyingsquirrel0419/layercache
- License: Apache-2.0
`;

function safeJoin(base: string, target: string): string | null {
  const resolved = path.resolve(base, target);
  if (!resolved.startsWith(base)) return null;
  return resolved;
}

function readDocMarkdown(slug: string): string | null {
  const fileName = slug || "index";
  const filePath = safeJoin(contentDir, `${fileName}.mdx`);
  if (!filePath) return null;
  if (!fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath, "utf-8");
}

function markdownResponse(body: string, tokens: number): Response {
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "X-Markdown-Tokens": String(tokens),
      Vary: "Accept",
      "Cache-Control": "public, max-age=300, s-maxage=3600",
    },
  });
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ path?: string[] }> }
) {
  const resolved = await params;
  const segments = resolved.path ?? [];

  if (segments.length === 0) {
    return markdownResponse(HOME_MARKDOWN, estimateTokens(HOME_MARKDOWN));
  }

  if (segments[0] === "docs") {
    const slug = segments.slice(1).join("/");
    const md = readDocMarkdown(slug);
    if (md) return markdownResponse(md, estimateTokens(md));

    if (slug === "") {
      const list = getAllDocs()
        .map((d) => `- [${d.title}](/docs/${d.slug}) — ${d.description}`)
        .join("\n");
      const body = `# Layercache Documentation\n\n${list}\n`;
      return markdownResponse(body, estimateTokens(body));
    }
  }

  return new Response("Not Found", {
    status: 404,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
