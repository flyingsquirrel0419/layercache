export const dynamic = "force-static";

const BASE = "https://layercache.dev";

// RFC 9728 OAuth 2.0 Protected Resource Metadata.
// Layercache's public docs and MCP server currently require no bearer
// authentication; authorization_servers is intentionally empty and
// bearer_methods_supported is omitted. Agents can still discover that no
// credentials are needed for read access.
const METADATA = {
  resource: BASE,
  authorization_servers: [] as string[],
  scopes_supported: [] as string[],
  bearer_methods_supported: ["header"],
  resource_documentation: `${BASE}/docs/api`,
  resource_name: "Layercache Documentation & MCP",
  resource_policy_uri: `${BASE}/robots.txt`,
};

export function GET() {
  return new Response(JSON.stringify(METADATA, null, 2), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=3600, s-maxage=86400",
    },
  });
}
