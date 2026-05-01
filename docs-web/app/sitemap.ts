import type { MetadataRoute } from "next";
import { getAllSlugs } from "@/lib/docs-config";

export default function sitemap(): MetadataRoute.Sitemap {
  const baseUrl = "https://layercache.dev";

  const docSlugs = getAllSlugs();
  const docPages = docSlugs.map((slug) => ({
    url: `${baseUrl}/docs/${slug}`,
    lastModified: new Date(),
    changeFrequency: "weekly" as const,
    priority: 0.8,
  }));

  return [
    {
      url: baseUrl,
      lastModified: new Date(),
      changeFrequency: "weekly",
      priority: 1,
    },
    {
      url: `${baseUrl}/docs`,
      lastModified: new Date(),
      changeFrequency: "weekly",
      priority: 0.9,
    },
    ...docPages,
    {
      url: `${baseUrl}/playground`,
      lastModified: new Date(),
      changeFrequency: "monthly",
      priority: 0.5,
    },
    {
      url: `${baseUrl}/.well-known/api-catalog`,
      lastModified: new Date(),
      changeFrequency: "monthly",
      priority: 0.3,
    },
    {
      url: `${baseUrl}/.well-known/agent-card.json`,
      lastModified: new Date(),
      changeFrequency: "monthly",
      priority: 0.3,
    },
    {
      url: `${baseUrl}/.well-known/mcp/server-card.json`,
      lastModified: new Date(),
      changeFrequency: "monthly",
      priority: 0.3,
    },
    {
      url: `${baseUrl}/.well-known/agent-skills/index.json`,
      lastModified: new Date(),
      changeFrequency: "monthly",
      priority: 0.3,
    },
  ];
}
