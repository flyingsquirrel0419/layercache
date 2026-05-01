export const dynamic = "force-static";

const BASE = "https://layercache.dev";

const INDEX = {
  $schema:
    "https://raw.githubusercontent.com/cloudflare/agent-skills-discovery-rfc/main/schema/v0.2.0/skills-index.schema.json",
  version: "0.2.0",
  publisher: {
    name: "Layercache",
    url: BASE,
  },
  skills: [
    {
      name: "layercache-getting-started",
      type: "documentation",
      description:
        "Install Layercache and configure a multi-layer cache stack (memory + Redis + disk) with stampede prevention.",
      url: `${BASE}/docs/getting-started`,
      sha256:
        "0000000000000000000000000000000000000000000000000000000000000000",
    },
    {
      name: "layercache-api-reference",
      type: "documentation",
      description:
        "Complete API reference for CacheStack, MemoryLayer, RedisLayer, DiskLayer, tags, wrap(), namespace(), and bulk ops.",
      url: `${BASE}/docs/api`,
      sha256:
        "0000000000000000000000000000000000000000000000000000000000000000",
    },
    {
      name: "layercache-invalidation",
      type: "documentation",
      description:
        "Tag-based, prefix, wildcard, and generation-based invalidation across all layers, with Redis pub/sub fan-out.",
      url: `${BASE}/docs/invalidation`,
      sha256:
        "0000000000000000000000000000000000000000000000000000000000000000",
    },
    {
      name: "layercache-resilience",
      type: "documentation",
      description:
        "Circuit breaker, stale-while-revalidate, stale-if-error, per-command timeouts, and graceful degradation.",
      url: `${BASE}/docs/resilience`,
      sha256:
        "0000000000000000000000000000000000000000000000000000000000000000",
    },
    {
      name: "layercache-observability",
      type: "documentation",
      description:
        "OpenTelemetry tracing, Prometheus metrics, event hooks, and HTTP stats endpoints.",
      url: `${BASE}/docs/observability`,
      sha256:
        "0000000000000000000000000000000000000000000000000000000000000000",
    },
    {
      name: "layercache-integrations",
      type: "documentation",
      description:
        "Middleware for Express, Fastify, Hono, tRPC, GraphQL, and Next.js.",
      url: `${BASE}/docs/integrations`,
      sha256:
        "0000000000000000000000000000000000000000000000000000000000000000",
    },
  ],
};

export function GET() {
  return new Response(JSON.stringify(INDEX, null, 2), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=3600, s-maxage=86400",
    },
  });
}
