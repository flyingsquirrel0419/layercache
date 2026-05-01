"use client";

import { useState, useEffect } from "react";
import { useHeadings } from "./SlugExtractor";

export default function TOC() {
  const headings = useHeadings();
  const [activeId, setActiveId] = useState<string | null>(null);

  useEffect(() => {
    if (headings.length === 0) return;

    document.documentElement.style.scrollBehavior = "smooth";

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            setActiveId(entry.target.id);
          }
        });
      },
      {
        rootMargin: "-100px 0px -80% 0px",
        threshold: 0,
      }
    );

    headings.forEach((heading) => {
      const element = document.getElementById(heading.id);
      if (element) {
        observer.observe(element);
      }
    });

    return () => {
      document.documentElement.style.scrollBehavior = "";
      headings.forEach((heading) => {
        const element = document.getElementById(heading.id);
        if (element) {
          observer.unobserve(element);
        }
      });
    };
  }, [headings]);

  if (headings.length === 0) {
    return null;
  }

  return (
    <nav className="space-y-1">
      {headings.map((heading) => (
        <a
          key={heading.id}
          href={`#${heading.id}`}
          className={`block text-sm transition-colors ${
            activeId === heading.id
              ? "text-accent font-medium"
              : "text-text-secondary hover:text-text-primary"
          } ${heading.level >= 3 ? "pl-4" : ""}`}
        >
          {heading.text}
        </a>
      ))}
    </nav>
  );
}
