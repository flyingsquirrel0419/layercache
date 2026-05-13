import { defineConfig, type UserConfig } from "@rspress/core";
import { pluginSitemap } from "@rspress/plugin-sitemap";

const IS_GITHUB_PAGES = process.env.GITHUB_PAGES === "true";
const LAYERCACHE_DOMAIN = "layercache.flyingsquirrel.me";
const CUSTOM_DOMAIN = (process.env.CUSTOM_DOMAIN ?? (IS_GITHUB_PAGES ? LAYERCACHE_DOMAIN : undefined))
  ?.replace(/^https?:\/\//, "")
  .replace(/\/+$/, "");
const DEFAULT_SITE_URL = CUSTOM_DOMAIN
  ? `https://${CUSTOM_DOMAIN}`
  : "https://flyingsquirrel0419.github.io/layercache";
const BASE_PATH = process.env.RSPRESS_BASE ?? (CUSTOM_DOMAIN ? "/" : IS_GITHUB_PAGES ? "/layercache/" : "/");
const SITE_URL = (process.env.SITE_URL ?? DEFAULT_SITE_URL).replace(/\/+$/, "");
const GOOGLE_ANALYTICS_ID = process.env.GOOGLE_ANALYTICS_ID;
const withBase = (path: string) => `${BASE_PATH.replace(/\/$/, "")}${path}`;
const googleAnalyticsHead: NonNullable<UserConfig["head"]> = GOOGLE_ANALYTICS_ID
  ? [
      [
        "script",
        {
          async: "",
          src: `https://www.googletagmanager.com/gtag/js?id=${GOOGLE_ANALYTICS_ID}`,
        },
      ],
      `\n<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());
  gtag('config', '${GOOGLE_ANALYTICS_ID}');
</script>`,
    ]
  : [];

export default defineConfig({
  root: "content",
  base: BASE_PATH,
  title: "Layercache",
  description: "Production-ready multi-layer caching for Node.js",
  icon: "/icon.svg",
  logo: "/icon.svg",
  logoText: "Layercache",
  lang: "en",
  ssg: true,
  llms: true,
  route: {
    cleanUrls: true,
  },
  head: [
    ["meta", { name: "ai-content-declaration", content: "Content-Signal: search=yes, ai-input=yes, ai-train=no" }],
    ["link", { rel: "service-doc", href: withBase("/docs/api"), type: "text/html", title: "Layercache API Reference" }],
    ...googleAnalyticsHead,
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
