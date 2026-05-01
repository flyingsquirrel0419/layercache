"use client";

import { useState, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useRouter } from "next/navigation";
import { searchDocs } from "@/app/actions/search";
import {
  getNextSelectedIndex,
  shouldApplySearchResponse,
} from "@/lib/docs/search-modal-state.mjs";

type SearchResult = {
  title: string;
  slug: string;
  snippet: string;
};

export function SearchModal({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const latestRequestIdRef = useRef(0);

  // Handle keyboard shortcuts
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((i) => getNextSelectedIndex(i, 1, results.length));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((i) => getNextSelectedIndex(i, -1, results.length));
      } else if (e.key === "Enter" && results.length > 0) {
        e.preventDefault();
        const result = results[selectedIndex];
        if (result) {
          router.push(result.slug ? `/docs/${result.slug}` : "/docs");
          onClose();
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose, results, selectedIndex, router]);

  // Reset state when modal opens/closes
  useEffect(() => {
    latestRequestIdRef.current += 1;

    if (isOpen) {
      setQuery("");
      setResults([]);
      setSelectedIndex(0);
      setIsLoading(false);
      return;
    }

    setIsLoading(false);
  }, [isOpen]);

  // Search with debounce
  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const timer = setTimeout(async () => {
      if (!query.trim()) {
        setResults([]);
        setIsLoading(false);
        return;
      }

      const requestId = latestRequestIdRef.current + 1;
      latestRequestIdRef.current = requestId;
      setIsLoading(true);
      try {
        const res = await searchDocs(query);
        if (!shouldApplySearchResponse({
          isOpen,
          latestRequestId: latestRequestIdRef.current,
          requestId,
        })) {
          return;
        }

        setResults(res);
        setSelectedIndex(0);
      } catch (error) {
        if (!shouldApplySearchResponse({
          isOpen,
          latestRequestId: latestRequestIdRef.current,
          requestId,
        })) {
          return;
        }

        console.error("Search error:", error);
        setResults([]);
      } finally {
        if (shouldApplySearchResponse({
          isOpen,
          latestRequestId: latestRequestIdRef.current,
          requestId,
        })) {
          setIsLoading(false);
        }
      }
    }, 200); // debounce 200ms

    return () => clearTimeout(timer);
  }, [isOpen, query]);

  const handleResultClick = (slug: string) => {
    router.push(slug ? `/docs/${slug}` : "/docs");
    onClose();
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          {/* Backdrop */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm"
            onClick={onClose}
          />

          {/* Modal */}
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              transition={{ duration: 0.15 }}
              className="w-full max-w-lg bg-background border border-border rounded-xl shadow-2xl overflow-hidden"
            >
              {/* Search Input */}
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search docs..."
                autoFocus
                className="w-full px-4 py-4 bg-transparent border-b border-border text-lg outline-none placeholder:text-text-secondary"
              />

              {/* Results */}
              <div className="max-h-80 overflow-y-auto">
                {isLoading && query.trim() && (
                  <div className="p-4 text-center text-text-secondary">Searching...</div>
                )}

                {!isLoading && query.trim() && results.length === 0 && (
                  <div className="p-4 text-center text-text-secondary">No results found</div>
                )}

                {!isLoading && results.length > 0 && (
                  <div>
                    {results.map((result, index) => (
                      <button
                        key={result.slug}
                        onClick={() => handleResultClick(result.slug)}
                        className={`w-full p-3 text-left hover:bg-surface transition-colors ${
                          index === selectedIndex ? "bg-surface" : ""
                        }`}
                      >
                        <div className="font-medium">{result.title}</div>
                        <div className="text-sm text-text-secondary truncate">{result.snippet}</div>
                      </button>
                    ))}
                  </div>
                )}

                {!query.trim() && (
                  <div className="p-4 text-center text-text-secondary text-sm">
                    Start typing to search...
                  </div>
                )}
              </div>
            </motion.div>
          </div>
        </>
      )}
    </AnimatePresence>
  );
}
