import { defineConfig } from "@rspress/core";
import { pluginSitemap } from "@rspress/plugin-sitemap";

const IS_GITHUB_PAGES = process.env.GITHUB_PAGES === "true";
const BASE_PATH = process.env.RSPRESS_BASE ?? (IS_GITHUB_PAGES ? "/layercache/" : "/");
const SITE_URL = (process.env.SITE_URL ?? "https://flyingsquirrel0419.github.io/layercache").replace(/\/+$/, "");
const withBase = (path: string) => `${BASE_PATH.replace(/\/$/, "")}${path}`;

export default defineConfig({
  root: "content",
  base: BASE_PATH,
  title: "Layercache",
  description: "Production-ready multi-layer caching for Node.js",
  icon: "/logo.png",
  logo: "/logo.png",
  logoText: "Layercache",
  lang: "en",
  ssg: true,
  llms: true,
  route: {
    cleanUrls: true,
  },
  head: [
    ["meta", { name: "ai-content-declaration", content: "Content-Signal: search=yes, ai-input=yes, ai-train=no" }],
    ["link", { rel: "api-catalog", href: withBase("/.well-known/api-catalog"), type: "application/linkset+json" }],
    ["link", { rel: "service-desc", href: withBase("/.well-known/mcp/server-card.json"), type: "application/json", title: "MCP Server Card" }],
    ["link", { rel: "service-desc", href: withBase("/.well-known/agent-card.json"), type: "application/json", title: "A2A Agent Card" }],
    ["link", { rel: "agent-skills", href: withBase("/.well-known/agent-skills/index.json"), type: "application/json" }],
    ["link", { rel: "service-doc", href: withBase("/docs/api"), type: "text/html", title: "Layercache API Reference" }],
  ],
  builderConfig: {
    output: {
      assetPrefix: BASE_PATH,
    },
  },
  themeConfig: {
    llmsUI: false,
    nav: [
      {
        text: "Docs",
        link: withBase("/docs/"),
      },
      {
        text: "Playground",
        link: withBase("/playground"),
      },
    ],
    sidebar: {
      "/": [
        {
          text: "Documentation",
          items: [
            {
              text: "Overview",
              link: withBase("/docs/"),
            },
            {
              text: "Getting Started",
              link: withBase("/docs/getting-started"),
            },
            {
              text: "Comparison",
              link: withBase("/docs/comparison"),
            },
          ],
        },
        {
          text: "Guides",
          collapsible: true,
          items: [
            {
              text: "Tutorial",
              link: withBase("/docs/tutorial"),
            },
            {
              text: "Migration Guide",
              link: withBase("/docs/migration"),
            },
            {
              text: "CLI Tool",
              link: withBase("/docs/cli"),
            },
          ],
        },
        {
          text: "API Reference",
          collapsible: true,
          items: [
            {
              text: "CacheStack",
              link: withBase("/docs/api"),
            },
            {
              text: "Cache Layers",
              link: withBase("/docs/layers"),
            },
            {
              text: "Invalidation",
              link: withBase("/docs/invalidation"),
            },
            {
              text: "Resilience",
              link: withBase("/docs/resilience"),
            },
            {
              text: "Serialization",
              link: withBase("/docs/serialization"),
            },
          ],
        },
        {
          text: "Integrations",
          collapsible: true,
          items: [
            {
              text: "Frameworks",
              link: withBase("/docs/integrations"),
            },
            {
              text: "Observability",
              link: withBase("/docs/observability"),
            },
            {
              text: "Distributed",
              link: withBase("/docs/distributed"),
            },
          ],
        },
      ],
    },
    socialLinks: [
      {
        icon: "github",
        mode: "link",
        content: "https://github.com/flyingsquirrel0419/layercache",
      },
    ],
    enableScrollToTop: true,
  },
  plugins: [
    pluginSitemap({
      siteUrl: SITE_URL,
      defaultChangeFreq: "weekly",
      defaultPriority: "0.8",
    }),
  ],
});
