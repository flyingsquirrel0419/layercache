import { getAllDocs } from "@/lib/mdx";

export const dynamic = "force-static";

export function GET() {
  const docs = getAllDocs().map((d) => ({
    title: d.title,
    slug: d.slug === "index" ? "" : d.slug,
    description: d.description,
  }));

  return new Response(JSON.stringify(docs), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=3600, s-maxage=86400",
    },
  });
}
