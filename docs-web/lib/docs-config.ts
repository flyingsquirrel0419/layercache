export type NavItem = {
  title: string;
  slug: string;
  children?: NavItem[];
};

export const docsNav: NavItem[] = [
  { title: "Overview", slug: "" },
  { title: "Getting Started", slug: "getting-started" },
  {
    title: "Guides",
    slug: "",
    children: [
      { title: "Tutorial", slug: "tutorial" },
      { title: "Migration Guide", slug: "migration" },
      { title: "CLI Tool", slug: "cli" },
    ],
  },
  {
    title: "API Reference",
    slug: "",
    children: [
      { title: "CacheStack", slug: "api" },
      { title: "Cache Layers", slug: "layers" },
      { title: "Invalidation", slug: "invalidation" },
      { title: "Resilience", slug: "resilience" },
      { title: "Serialization", slug: "serialization" },
    ],
  },
  {
    title: "Integrations",
    slug: "",
    children: [
      { title: "Frameworks", slug: "integrations" },
      { title: "Observability", slug: "observability" },
      { title: "Distributed", slug: "distributed" },
    ],
  },
];

export function getAllSlugs(): string[] {
  const slugs: string[] = [];
  for (const item of docsNav) {
    if (item.slug) slugs.push(item.slug);
    if (item.children) {
      for (const child of item.children) {
        if (child.slug) slugs.push(child.slug);
      }
    }
  }
  return slugs;
}
