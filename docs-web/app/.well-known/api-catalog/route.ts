export const dynamic = "force-static";

const BASE = "https://layercache.dev";

const CATALOG = {
  linkset: [
    {
      anchor: `${BASE}/`,
      "service-desc": [
        {
          href: `${BASE}/.well-known/mcp/server-card.json`,
          type: "application/json",
          title: "MCP Server Card",
        },
        {
          href: `${BASE}/.well-known/agent-card.json`,
          type: "application/json",
          title: "A2A Agent Card",
        },
      ],
      "service-doc": [
        {
          href: `${BASE}/docs`,
          type: "text/html",
          title: "Layercache Documentation",
        },
        {
          href: `${BASE}/docs/api`,
          type: "text/html",
          title: "Layercache API Reference",
        },
      ],
      "service-meta": [
        {
          href: `${BASE}/.well-known/agent-skills/index.json`,
          type: "application/json",
          title: "Agent Skills Discovery Index",
        },
      ],
      status: [
        {
          href: `${BASE}/docs`,
          type: "text/html",
        },
      ],
      author: [
        {
          href: "https://github.com/flyingsquirrel0419/layercache",
          title: "Layercache on GitHub",
        },
      ],
      license: [
        {
          href: "https://www.apache.org/licenses/LICENSE-2.0",
          title: "Apache License 2.0",
        },
      ],
    },
  ],
};

export function GET() {
  return new Response(JSON.stringify(CATALOG, null, 2), {
    status: 200,
    headers: {
      "Content-Type": "application/linkset+json",
      "Cache-Control": "public, max-age=3600, s-maxage=86400",
    },
  });
}
