export const dynamic = "force-static";

const BODY = `# Layercache robots.txt
# Content Signals (https://contentsignals.org, draft-romm-aipref-contentsignals)
# Declares preferences for how this site's public content may be used.
Content-Signal: search=yes, ai-input=yes, ai-train=no

User-agent: *
Allow: /
Disallow: /playground
Disallow: /api/markdown

Sitemap: https://layercache.dev/sitemap.xml
`;

export function GET() {
  return new Response(BODY, {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=3600, s-maxage=86400",
    },
  });
}
