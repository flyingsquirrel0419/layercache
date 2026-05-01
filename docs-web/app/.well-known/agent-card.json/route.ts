export const dynamic = "force-static";

const BASE = "https://layercache.dev";

const CARD = {
  name: "Layercache Docs Agent",
  version: "1.3.2",
  description:
    "Documentation agent for Layercache, a production-grade multi-layer caching toolkit for Node.js. Answers questions about the API, layers, invalidation, resilience, and integrations.",
  url: BASE,
  provider: {
    organization: "Layercache",
    url: "https://github.com/flyingsquirrel0419/layercache",
  },
  documentationUrl: `${BASE}/docs`,
  supportedInterfaces: [
    {
      transport: "http+markdown",
      url: `${BASE}/`,
      description:
        "Any page on layercache.dev returns text/markdown when requested with Accept: text/markdown.",
    },
  ],
  capabilities: {
    streaming: false,
    pushNotifications: false,
    stateTransitionHistory: false,
  },
  defaultInputModes: ["text/plain", "text/markdown"],
  defaultOutputModes: ["text/markdown", "text/html"],
  skills: [
    {
      id: "search-docs",
      name: "Search Docs",
      description:
        "Search the Layercache documentation for APIs, options, and usage patterns.",
      tags: ["docs", "search"],
    },
    {
      id: "get-started",
      name: "Get Started Guide",
      description:
        "Walk a developer through installing Layercache and configuring memory, Redis, and disk layers.",
      tags: ["tutorial", "install"],
    },
    {
      id: "api-reference",
      name: "API Reference Lookup",
      description:
        "Retrieve reference docs for CacheStack, MemoryLayer, RedisLayer, DiskLayer, invalidation, and resilience APIs.",
      tags: ["api", "reference"],
    },
  ],
};

export function GET() {
  return new Response(JSON.stringify(CARD, null, 2), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=3600, s-maxage=86400",
    },
  });
}
