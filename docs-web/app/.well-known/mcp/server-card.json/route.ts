export const dynamic = "force-static";

const BASE = "https://layercache.dev";

const CARD = {
  $schema:
    "https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/schema/server-card.schema.json",
  serverInfo: {
    name: "layercache-docs",
    version: "1.3.2",
    title: "Layercache Documentation MCP Server",
    description:
      "Read-only MCP server exposing Layercache documentation and API reference as tools and resources for AI agents.",
  },
  transport: {
    type: "http",
    url: `${BASE}/mcp`,
  },
  capabilities: {
    tools: { listChanged: false },
    resources: { subscribe: false, listChanged: false },
    prompts: { listChanged: false },
    logging: {},
  },
  tools: [
    {
      name: "search_docs",
      description:
        "Full-text search across the Layercache documentation. Returns matching pages with titles, URLs, and excerpts.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query" },
          limit: { type: "integer", minimum: 1, maximum: 20, default: 5 },
        },
        required: ["query"],
      },
    },
    {
      name: "get_doc",
      description:
        "Retrieve a single documentation page as markdown by slug (e.g. 'getting-started', 'api', 'resilience').",
      inputSchema: {
        type: "object",
        properties: {
          slug: { type: "string" },
        },
        required: ["slug"],
      },
    },
  ],
  resources: [
    {
      uri: `${BASE}/docs`,
      name: "Layercache Docs Index",
      mimeType: "text/html",
    },
    {
      uri: `${BASE}/.well-known/api-catalog`,
      name: "API Catalog",
      mimeType: "application/linkset+json",
    },
  ],
  metadata: {
    license: "Apache-2.0",
    homepage: BASE,
    repository: "https://github.com/flyingsquirrel0419/layercache",
  },
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
