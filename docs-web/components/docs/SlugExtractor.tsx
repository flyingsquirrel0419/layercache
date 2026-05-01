"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

interface HeadingInfo {
  id: string;
  text: string;
  level: number;
}

const HeadingsContext = createContext<HeadingInfo[]>([]);

export function useHeadings() {
  return useContext(HeadingsContext);
}

export default function SlugExtractor({ children }: { children: ReactNode }) {
  const [headings, setHeadings] = useState<HeadingInfo[]>([]);

  useEffect(() => {
    // Find all h2 and h3 headings rendered by MDX with rehype-slug
    const main = document.querySelector("main");
    if (!main) return;

    const elements = main.querySelectorAll("h2[id], h3[id]");
    const extracted: HeadingInfo[] = [];
    elements.forEach((el) => {
      extracted.push({
        id: el.id,
        text: el.textContent || "",
        level: parseInt(el.tagName[1], 10),
      });
    });
    setHeadings(extracted);
  }, []);

  return (
    <HeadingsContext.Provider value={headings}>
      {children}
    </HeadingsContext.Provider>
  );
}
