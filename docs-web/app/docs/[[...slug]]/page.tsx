import fs from "fs";
import path from "path";
import matter from "gray-matter";
import { notFound } from "next/navigation";
import { MDXRemote } from "next-mdx-remote/rsc";
import { getAllSlugs } from "@/lib/docs-config";
import { getMDXComponents } from "@/components/docs/MDXComponents";
import Sidebar from "@/components/docs/Sidebar";
import TOC from "@/components/docs/TOC";
import type { Metadata } from "next";
import rehypeHighlight from "rehype-highlight";
import rehypeSlug from "rehype-slug";
import SlugExtractor from "@/components/docs/SlugExtractor";

type Props = {
  params: Promise<{ slug?: string[] }>;
};

export async function generateStaticParams() {
  const slugs = getAllSlugs();
  return slugs.map((slug) => ({ slug: slug ? [slug] : [] }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const slugStr = slug?.join("/") || "";
  const contentDir = path.join(process.cwd(), "content/docs");
  const filePath = path.join(contentDir, `${slugStr || "index"}.mdx`);
  try {
    const source = fs.readFileSync(filePath, "utf-8");
    const { data } = matter(source);
    return {
      title: `${data.title || "Docs"} — Layercache`,
      description: data.description || "",
    };
  } catch {
    return { title: "Layercache Docs" };
  }
}

export default async function DocPage({ params }: Props) {
  const { slug } = await params;
  const slugStr = slug?.join("/") || "";

  const contentDir = path.join(process.cwd(), "content/docs");
  const filePath = path.join(contentDir, `${slugStr || "index"}.mdx`);

  try {
    const source = fs.readFileSync(filePath, "utf-8");
    const { data, content } = matter(source);

    const components = getMDXComponents();

    return (
      <>
        {/* Sidebar: mobile toggle+drawer lives here, outside the lg:hidden aside */}
        <Sidebar currentSlug={slugStr} />

        <main className="flex-1 min-w-0 px-6 py-8 lg:px-12 max-w-none">
          <h1 className="text-4xl font-bold mb-2">{data.title}</h1>
          {data.description && (
            <p className="text-text-secondary text-lg mb-8">{data.description}</p>
          )}
          <div className="prose-custom">
            <MDXRemote
              source={content}
              components={components}
              options={{
                mdxOptions: {
                  rehypePlugins: [rehypeSlug, rehypeHighlight],
                  format: "mdx",
                },
              }}
            />
          </div>
        </main>

        {/* TOC with client-side slug extraction to match rehype-slug */}
        <SlugExtractor>
          <aside className="hidden xl:block w-50 flex-shrink-0 border-l border-border h-[calc(100vh-4rem)] sticky top-16 overflow-y-auto p-4">
            <TOC />
          </aside>
        </SlugExtractor>
      </>
    );
  } catch (error) {
    notFound();
  }
}
