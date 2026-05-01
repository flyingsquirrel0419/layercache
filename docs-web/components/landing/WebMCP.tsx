"use client";

import { useEffect } from "react";

type WebMCPTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute: (input: Record<string, unknown>) => Promise<unknown> | unknown;
};

type ModelContext = {
  provideContext: (ctx: { tools: WebMCPTool[] }) => void | Promise<void>;
};

declare global {
  interface Navigator {
    modelContext?: ModelContext;
  }
}

const DOC_LINKS: Record<string, string> = {
  overview: "/docs",
  "getting-started": "/docs/getting-started",
  tutorial: "/docs/tutorial",
  api: "/docs/api",
  layers: "/docs/layers",
  invalidation: "/docs/invalidation",
  resilience: "/docs/resilience",
  serialization: "/docs/serialization",
  observability: "/docs/observability",
  distributed: "/docs/distributed",
  integrations: "/docs/integrations",
  migration: "/docs/migration",
  cli: "/docs/cli",
};

export function WebMCP() {
  useEffect(() => {
    if (typeof navigator === "undefined" || !navigator.modelContext) return;

    const tools: WebMCPTool[] = [
      {
        name: "open_layercache_docs",
        description:
          "Open a Layercache documentation page in the current tab. Accepts a known slug (e.g. 'getting-started', 'api', 'resilience').",
        inputSchema: {
          type: "object",
          properties: {
            slug: {
              type: "string",
              description:
                "Documentation slug. One of: overview, getting-started, tutorial, api, layers, invalidation, resilience, serialization, observability, distributed, integrations, migration, cli.",
            },
          },
          required: ["slug"],
        },
        execute: async ({ slug }) => {
          const target =
            DOC_LINKS[(slug as string) ?? ""] ?? "/docs";
          window.location.assign(target);
          return { navigated: true, url: target };
        },
      },
      {
        name: "search_layercache_docs",
        description:
          "Search the Layercache documentation. Returns matching pages with title, URL, and an excerpt.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Search query" },
            limit: {
              type: "integer",
              minimum: 1,
              maximum: 20,
              default: 5,
            },
          },
          required: ["query"],
        },
        execute: async ({ query, limit }) => {
          const q = (query as string) ?? "";
          const n = Math.max(1, Math.min(20, (limit as number) ?? 5));
          try {
            const res = await fetch("/search-index.json", {
              headers: { Accept: "application/json" },
            });
            if (!res.ok) throw new Error("search index unavailable");
            const index: Array<{
              title: string;
              slug: string;
              description: string;
            }> = await res.json();
            const needle = q.toLowerCase();
            return index
              .filter(
                (d) =>
                  d.title.toLowerCase().includes(needle) ||
                  d.description.toLowerCase().includes(needle)
              )
              .slice(0, n)
              .map((d) => ({
                title: d.title,
                url: `/docs/${d.slug}`,
                excerpt: d.description,
              }));
          } catch {
            return Object.entries(DOC_LINKS)
              .filter(([slug]) => slug.includes(q.toLowerCase()))
              .slice(0, n)
              .map(([slug, url]) => ({
                title: slug,
                url,
                excerpt: "",
              }));
          }
        },
      },
      {
        name: "get_install_command",
        description:
          "Return the install command for Layercache for a chosen package manager.",
        inputSchema: {
          type: "object",
          properties: {
            packageManager: {
              type: "string",
              enum: ["npm", "pnpm", "yarn", "bun"],
              default: "npm",
            },
          },
        },
        execute: async ({ packageManager }) => {
          const pm = (packageManager as string) ?? "npm";
          const cmd =
            pm === "pnpm"
              ? "pnpm add layercache"
              : pm === "yarn"
              ? "yarn add layercache"
              : pm === "bun"
              ? "bun add layercache"
              : "npm install layercache";
          return { command: cmd, requires: "Node.js >= 20" };
        },
      },
    ];

    Promise.resolve(navigator.modelContext.provideContext({ tools })).catch(
      () => {
        /* WebMCP not supported; fail silently */
      }
    );
  }, []);

  return null;
}
