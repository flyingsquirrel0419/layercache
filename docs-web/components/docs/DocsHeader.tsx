"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { SearchModal } from "./SearchModal";
import { ThemeToggle } from "@/components/ui/ThemeToggle";

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
      <header className="sticky top-0 z-40 flex h-16 items-center justify-between bg-white px-4 shadow-[rgba(0,0,0,0.12)_0px_4px_16px_0px] sm:px-6">
        <div className="flex items-center gap-2">
          <Link href="/" className="flex items-center gap-3 font-bold text-text-primary">
            <img src="/logo.png" alt="" className="h-7 w-24 object-contain object-left" />
            Layercache
          </Link>
          <span className="text-[#afafaf]">/</span>
          <span className="text-[#4b4b4b]">Docs</span>
        </div>

        <div className="flex items-center gap-2">
          <ThemeToggle />
          <button
            onClick={() => setSearchOpen(true)}
            className="group relative flex h-10 w-10 items-center justify-center rounded-full bg-[#efefef] text-black transition-colors duration-150 hover:bg-[#e2e2e2]"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <span className="sr-only">Search</span>
            <span className="absolute right-0 top-14 hidden whitespace-nowrap rounded-lg bg-white px-3 py-2 text-xs text-[#4b4b4b] shadow-[rgba(0,0,0,0.16)_0px_2px_8px_0px] group-hover:block">
              Search <kbd className="ml-1 rounded-full bg-[#efefef] px-2 py-1 text-black">⌘ K</kbd>
            </span>
          </button>
        </div>
      </header>

      <SearchModal isOpen={searchOpen} onClose={() => setSearchOpen(false)} />
    </>
  );
}
