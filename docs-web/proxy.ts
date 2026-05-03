import { NextRequest, NextResponse } from "next/server";

const HOMEPAGE_LINKS = [
  '</.well-known/api-catalog>; rel="api-catalog"; type="application/linkset+json"',
  '</.well-known/agent-card.json>; rel="service-desc"; type="application/json"; title="A2A Agent Card"',
  '</.well-known/mcp/server-card.json>; rel="service-desc"; type="application/json"; title="MCP Server Card"',
  '</.well-known/agent-skills/index.json>; rel="agent-skills"; type="application/json"',
  '</docs/api>; rel="service-doc"; type="text/html"; title="Layercache API Reference"',
  '</docs>; rel="help"; type="text/html"; title="Layercache Documentation"',
  '<https://github.com/flyingsquirrel0419/layercache>; rel="vcs-repository"',
  '<https://github.com/flyingsquirrel0419/layercache/issues>; rel="issues"',
];

const DOCS_LINKS = [
  '</.well-known/api-catalog>; rel="api-catalog"; type="application/linkset+json"',
  '</docs/api>; rel="service-doc"; type="text/html"',
  '</>; rel="home"',
];

function shouldNegotiateMarkdown(accept: string | null): boolean {
  if (!accept) return false;
  const tokens = accept.split(",").map((t) => t.trim().toLowerCase());
  const mdQ = tokens
    .filter((t) => t.startsWith("text/markdown") || t.startsWith("text/x-markdown"))
    .map((t) => {
      const q = /;\s*q=([0-9.]+)/.exec(t);
      return q ? parseFloat(q[1]) : 1;
    })
    .reduce((a, b) => Math.max(a, b), 0);
  const htmlQ = tokens
    .filter((t) => t.startsWith("text/html") || t.startsWith("application/xhtml"))
    .map((t) => {
      const q = /;\s*q=([0-9.]+)/.exec(t);
      return q ? parseFloat(q[1]) : 1;
    })
    .reduce((a, b) => Math.max(a, b), 0);
  return mdQ > 0 && mdQ >= htmlQ;
}

export function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const accept = req.headers.get("accept");

  if (shouldNegotiateMarkdown(accept) && !pathname.startsWith("/api/markdown")) {
    const rewriteUrl = req.nextUrl.clone();
    rewriteUrl.pathname = `/api/markdown${pathname === "/" ? "" : pathname}`;
    const res = NextResponse.rewrite(rewriteUrl);
    res.headers.set("Vary", "Accept");
    return res;
  }

  const res = NextResponse.next();
  res.headers.append("Vary", "Accept");

  if (pathname === "/") {
    res.headers.set("Link", HOMEPAGE_LINKS.join(", "));
  } else if (pathname === "/docs" || pathname.startsWith("/docs/")) {
    res.headers.set("Link", DOCS_LINKS.join(", "));
  }

  return res;
}

export const config = {
  matcher: ["/((?!_next/|favicon.ico|logo.png|sitemap.xml|robots.txt).*)"],
};
