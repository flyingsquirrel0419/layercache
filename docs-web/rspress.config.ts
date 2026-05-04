import { defineConfig } from "@rspress/core";
import { pluginSitemap } from "@rspress/plugin-sitemap";

const SITE_URL = (process.env.SITE_URL ?? "https://layercache.flyingsquirrel.me").replace(/\/+$/, "");

export default defineConfig({
  root: "content",
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
    ["link", { rel: "api-catalog", href: "/.well-known/api-catalog", type: "application/linkset+json" }],
    ["link", { rel: "service-desc", href: "/.well-known/mcp/server-card.json", type: "application/json", title: "MCP Server Card" }],
    ["link", { rel: "service-desc", href: "/.well-known/agent-card.json", type: "application/json", title: "A2A Agent Card" }],
    ["link", { rel: "agent-skills", href: "/.well-known/agent-skills/index.json", type: "application/json" }],
    ["link", { rel: "service-doc", href: "/docs/api", type: "text/html", title: "Layercache API Reference" }],
  ],
  themeConfig: {
    llmsUI: false,
    nav: [
      {
        text: "Docs",
        link: "/docs/",
      },
      {
        text: "Playground",
        link: "/playground",
      },
    ],
    sidebar: {
      "/": [
        {
          text: "Documentation",
          items: [
            {
              text: "Overview",
              link: "/docs/",
            },
            {
              text: "Getting Started",
              link: "/docs/getting-started",
            },
            {
              text: "Comparison",
              link: "/docs/comparison",
            },
          ],
        },
        {
          text: "Guides",
          collapsible: true,
          items: [
            {
              text: "Tutorial",
              link: "/docs/tutorial",
            },
            {
              text: "Migration Guide",
              link: "/docs/migration",
            },
            {
              text: "CLI Tool",
              link: "/docs/cli",
            },
          ],
        },
        {
          text: "API Reference",
          collapsible: true,
          items: [
            {
              text: "CacheStack",
              link: "/docs/api",
            },
            {
              text: "Cache Layers",
              link: "/docs/layers",
            },
            {
              text: "Invalidation",
              link: "/docs/invalidation",
            },
            {
              text: "Resilience",
              link: "/docs/resilience",
            },
            {
              text: "Serialization",
              link: "/docs/serialization",
            },
          ],
        },
        {
          text: "Integrations",
          collapsible: true,
          items: [
            {
              text: "Frameworks",
              link: "/docs/integrations",
            },
            {
              text: "Observability",
              link: "/docs/observability",
            },
            {
              text: "Distributed",
              link: "/docs/distributed",
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
