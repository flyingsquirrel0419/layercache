"use client";

import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import Link from "next/link";
import { BookIcon, GithubIcon, TerminalIcon } from "@/components/ui/Icons";
import { ThemeToggle } from "@/components/ui/ThemeToggle";

export function Navbar() {
  const [scrolled, setScrolled] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    const handler = () => setScrolled(window.scrollY > 20);
    window.addEventListener("scroll", handler, { passive: true });
    return () => window.removeEventListener("scroll", handler);
  }, []);

  return (
    <nav
      className={`sticky top-0 z-50 transition-all duration-300 ${
        scrolled
          ? "bg-white/95 shadow-[rgba(0,0,0,0.12)_0px_4px_16px_0px]"
          : "bg-white"
      }`}
    >
      <div className="uber-container flex h-16 items-center justify-between px-4 sm:px-6">
        <Link href="/" className="flex items-center gap-3" aria-label="Layercache home">
          <img src="/logo.png" alt="" className="h-7 w-24 object-contain object-left" />
          <span className="text-lg font-bold leading-none text-text-primary">Layercache</span>
        </Link>

        <div className="hidden md:flex items-center gap-2">
          <Link
            href="/docs"
            className="uber-pill flex items-center gap-2 bg-[#efefef] px-4 py-2 text-sm font-medium text-black transition-colors hover:bg-[#e2e2e2]"
          >
            <BookIcon className="h-4 w-4" />
            Docs
          </Link>
          <Link
            href="/playground"
            className="uber-pill flex items-center gap-2 bg-[#efefef] px-4 py-2 text-sm font-medium text-black transition-colors hover:bg-[#e2e2e2]"
          >
            <TerminalIcon className="h-4 w-4" />
            Playground
          </Link>
          <a
            href="https://github.com/flyingsquirrel0419/layercache"
            target="_blank"
            rel="noopener noreferrer"
            className="uber-pill flex items-center gap-2 bg-black px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-[#2a2a2a]"
          >
            <GithubIcon className="h-4 w-4" />
            GitHub
          </a>
          <ThemeToggle />
        </div>

        {/* Mobile menu */}
        <div className="flex md:hidden items-center gap-3">
          <ThemeToggle />
          <button
            onClick={() => setMobileOpen(!mobileOpen)}
            className="flex h-10 w-10 items-center justify-center rounded-full bg-[#efefef] text-black transition-colors hover:bg-[#e2e2e2]"
            aria-label="Toggle menu"
          >
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            >
              <line x1="3" y1="6" x2="21" y2="6" />
              <line x1="3" y1="12" x2="21" y2="12" />
              <line x1="3" y1="18" x2="21" y2="18" />
            </svg>
          </button>
        </div>
      </div>

      {/* Mobile dropdown */}
      {mobileOpen && (
        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          className="md:hidden bg-white px-6 py-4 shadow-[rgba(0,0,0,0.12)_0px_4px_16px_0px]"
        >
          <Link
            href="/docs"
            className="mb-2 flex items-center gap-2 rounded-full bg-[#efefef] px-4 py-3 text-sm font-medium text-black"
          >
            <BookIcon className="h-4 w-4" />
            Docs
          </Link>
          <Link
            href="/playground"
            className="mb-2 flex items-center gap-2 rounded-full bg-[#efefef] px-4 py-3 text-sm font-medium text-black"
          >
            <TerminalIcon className="h-4 w-4" />
            Playground
          </Link>
          <a
            href="https://github.com/flyingsquirrel0419/layercache"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2 rounded-full bg-black px-4 py-3 text-sm font-medium text-white"
          >
            <GithubIcon className="h-4 w-4" />
            GitHub
          </a>
        </motion.div>
      )}
    </nav>
  );
}
