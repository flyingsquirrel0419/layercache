import fs from "fs";
import path from "path";
import matter from "gray-matter";

const contentDir = path.join(process.cwd(), "content/docs");

export type DocMeta = {
  title: string;
  description: string;
  slug: string;
};

export type DocData = {
  meta: DocMeta;
  content: string;
  headings: { id: string; text: string; level: number }[];
};

export function getDocBySlug(slug: string): DocData {
  const fileName = slug || "index";
  const filePath = path.join(contentDir, `${fileName}.mdx`);
  const source = fs.readFileSync(filePath, "utf-8");
  const { data, content } = matter(source);
  const headings = extractHeadings(content);

  return {
    meta: {
      title: data.title || fileName,
      description: data.description || "",
      slug,
    },
    content,
    headings,
  };
}

export function getAllDocs(): DocMeta[] {
  const files = fs.readdirSync(contentDir).filter((f) => f.endsWith(".mdx"));
  return files.map((file) => {
    const source = fs.readFileSync(path.join(contentDir, file), "utf-8");
    const { data } = matter(source);
    return {
      title: data.title || file.replace(".mdx", ""),
      description: data.description || "",
      slug: file.replace(".mdx", ""),
    };
  });
}

function extractHeadings(content: string): { id: string; text: string; level: number }[] {
  const headingRegex = /^(#{2,3})\s+(.+)$/gm;
  const headings: { id: string; text: string; level: number }[] = [];
  let match;
  while ((match = headingRegex.exec(content)) !== null) {
    const text = match[2].trim();
    const id = text.toLowerCase().replace(/[^\w]+/g, "-");
    headings.push({ id, text, level: match[1].length });
  }
  return headings;
}
