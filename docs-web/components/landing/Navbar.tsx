"use client";

import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import ThemeToggle from "@/components/ui/ThemeToggle";
import Link from "next/link";

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
          ? "bg-background/80 backdrop-blur-lg border-b border-border"
          : ""
      }`}
    >
      <div className="max-w-6xl mx-auto flex items-center justify-between h-16 px-6">
        {/* Logo + Name */}
        <Link href="/" className="flex items-center gap-2">
          <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
            <rect
              x="2"
              y="16"
              width="24"
              height="6"
              rx="2"
              fill="#6366f1"
              opacity="0.9"
            />
            <rect
              x="4"
              y="9"
              width="20"
              height="6"
              rx="2"
              fill="#6366f1"
              opacity="0.7"
            />
            <rect
              x="6"
              y="2"
              width="16"
              height="6"
              rx="2"
              fill="#6366f1"
              opacity="0.5"
            />
          </svg>
          <span className="font-bold text-lg">Layercache</span>
        </Link>

        {/* Desktop nav links */}
        <div className="hidden md:flex items-center gap-6">
          <Link
            href="/docs"
            className="text-text-secondary hover:text-text-primary transition-colors text-sm"
          >
            Docs
          </Link>
          <Link
            href="/playground"
            className="text-text-secondary hover:text-text-primary transition-colors text-sm"
          >
            Playground
          </Link>
          <a
            href="https://github.com/flyingsquirrel0419/layercache"
            target="_blank"
            rel="noopener noreferrer"
            className="text-text-secondary hover:text-text-primary transition-colors text-sm"
          >
            GitHub
          </a>
          <ThemeToggle />
        </div>

        {/* Mobile menu */}
        <div className="flex md:hidden items-center gap-3">
          <ThemeToggle />
          <button
            onClick={() => setMobileOpen(!mobileOpen)}
            className="p-2 text-text-secondary hover:text-text-primary"
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
          className="md:hidden border-b border-border bg-background/95 backdrop-blur-lg px-6 py-4 space-y-3"
        >
          <Link
            href="/docs"
            className="block text-text-secondary hover:text-text-primary"
          >
            Docs
          </Link>
          <Link
            href="/playground"
            className="block text-text-secondary hover:text-text-primary"
          >
            Playground
          </Link>
          <a
            href="https://github.com/flyingsquirrel0419/layercache"
            target="_blank"
            rel="noopener noreferrer"
            className="block text-text-secondary hover:text-text-primary"
          >
            GitHub
          </a>
        </motion.div>
      )}
    </nav>
  );
}
