"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import ThemeToggle from "@/components/ui/ThemeToggle";
import { SearchModal } from "./SearchModal";

export function DocsHeader() {
  const [searchOpen, setSearchOpen] = useState(false);

  // Handle Cmd+K / Ctrl+K
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setSearchOpen(true);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  return (
    <>
      <header className="sticky top-0 z-40 h-16 flex items-center justify-between px-6 border-b border-border bg-background/80 backdrop-blur-lg">
        <div className="flex items-center gap-2">
          <Link href="/" className="font-semibold text-text-primary">
            Layercache
          </Link>
          <span className="text-text-secondary">/</span>
          <span className="text-text-secondary">Docs</span>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => setSearchOpen(true)}
            className="w-9 h-9 rounded-lg flex items-center justify-center text-text-secondary hover:text-text-primary hover:bg-surface transition-colors duration-150 group relative"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <span className="sr-only">Search</span>
            <span className="absolute top-14 right-6 hidden group-hover:block bg-surface border border-border rounded-md px-2 py-1 text-xs text-text-secondary whitespace-nowrap">
              Search <kbd className="ml-1 px-1.5 py-0.5 bg-background rounded border border-border">⌘ K</kbd>
            </span>
          </button>
          <ThemeToggle />
        </div>
      </header>

      <SearchModal isOpen={searchOpen} onClose={() => setSearchOpen(false)} />
    </>
  );
}
