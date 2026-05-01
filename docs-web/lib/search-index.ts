import { Index } from "flexsearch";
import fs from "fs";
import path from "path";
import matter from "gray-matter";

const contentDir = path.join(process.cwd(), "content/docs");

export type SearchResult = {
  title: string;
  slug: string;
  snippet: string;
};

let index: Index | null = null;
let documents: Map<number, { title: string; slug: string; content: string }> = new Map();

function buildIndex() {
  if (index) return;

  index = new Index({
    preset: "match",
    tokenize: "forward",
    resolution: 9,
  });

  const files = fs.readdirSync(contentDir).filter((f) => f.endsWith(".mdx"));

  files.forEach((file, i) => {
    const source = fs.readFileSync(path.join(contentDir, file), "utf-8");
    const { data, content } = matter(source);
    let slug = file.replace(".mdx", "");

    // Normalize "index" to empty string so routes resolve to /docs not /docs/index
    if (slug === "index") slug = "";

    documents.set(i, {
      title: data.title || slug,
      slug,
      content,
    });

    if (index) {
      index.add(i, `${data.title} ${data.description || ""} ${content}`);
    }
  });
}

export function search(query: string): SearchResult[] {
  buildIndex();

  if (!index || !query.trim()) return [];

  const results = index.search(query, { limit: 10 }) as number[];

  return results.map((id) => {
    const doc = documents.get(id as number);
    if (!doc) return null;

    // Extract a snippet around the first match
    const lowerContent = doc.content.toLowerCase();
    const matchIndex = lowerContent.indexOf(query.toLowerCase());
    let snippet = "";
    if (matchIndex >= 0) {
      const start = Math.max(0, matchIndex - 60);
      const end = Math.min(doc.content.length, matchIndex + query.length + 60);
      snippet = (start > 0 ? "..." : "") + doc.content.slice(start, end).replace(/\n/g, " ") + (end < doc.content.length ? "..." : "");
    } else {
      snippet = doc.content.slice(0, 120).replace(/\n/g, " ") + "...";
    }

    return {
      title: doc.title,
      slug: doc.slug,
      snippet,
    };
  }).filter(Boolean) as SearchResult[];
}
