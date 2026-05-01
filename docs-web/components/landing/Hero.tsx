"use client";

import { motion, useReducedMotion } from "framer-motion";
import { useEffect, useState } from "react";
import Button from "@/components/ui/Button";

const CODE_SNIPPET = `import { CacheStack, MemoryLayer, RedisLayer } from 'layercache';
import Redis from 'ioredis';

const cache = new CacheStack([
  new MemoryLayer({ ttl: 30_000, maxSize: 5_000 }),
  new RedisLayer({
    client: new Redis(),
    ttl: 300_000,
    commandTimeoutMs: 50, // v1.3+ per-command Redis timeouts
  }),
]);

const user = await cache.get('user:123', () => db.findUser(123));`;

export function Hero() {
  const reducedMotion = useReducedMotion();
  const [displayedCode, setDisplayedCode] = useState("");
  const [showCursor, setShowCursor] = useState(true);

  // Typing animation
  useEffect(() => {
    if (reducedMotion) {
      setDisplayedCode(CODE_SNIPPET);
      return;
    }

    let index = 0;
    const interval = setInterval(() => {
      if (index <= CODE_SNIPPET.length) {
        setDisplayedCode(CODE_SNIPPET.slice(0, index));
        index++;
      } else {
        clearInterval(interval);
      }
    }, 40);

    return () => clearInterval(interval);
  }, [reducedMotion]);

  // Blinking cursor
  useEffect(() => {
    if (reducedMotion) {
      setShowCursor(false);
      return;
    }

    const interval = setInterval(() => {
      setShowCursor((prev) => !prev);
    }, 530);

    return () => clearInterval(interval);
  }, [reducedMotion]);

  return (
    <section className="min-h-screen flex flex-col items-center justify-center px-6 overflow-hidden relative">
      {/* Background gradient effects */}
      <div className="absolute inset-0 -z-10">
        <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-accent/20 rounded-full blur-3xl animate-pulse-slow"></div>
        <div className="absolute bottom-1/4 right-1/4 w-96 h-96 bg-accent-light/10 rounded-full blur-3xl animate-pulse-slow animation-delay-2000"></div>
      </div>

      {/* Hero content */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.8, ease: "easeOut" }}
        className="text-center"
      >
        <h1 className="text-5xl md:text-7xl font-bold tracking-tight mb-6">
          Production-Ready
          <br />
          <span className="text-accent">Multi-Layer Caching</span>
          <br />
          for Node.js
        </h1>

        <p className="text-lg md:text-xl text-text-secondary mb-6 max-w-2xl mx-auto">
          Stack memory, Redis, and disk behind one API — with single-flight
          stampede prevention, tag invalidation, and graceful degradation when
          layers fail.
        </p>

        <div className="flex items-center justify-center gap-2 mb-8 flex-wrap">
          <span className="text-xs font-medium px-2.5 py-1 rounded-full bg-accent/10 text-accent border border-accent/20">
            v2.0.0
          </span>
          <span className="text-xs font-medium px-2.5 py-1 rounded-full bg-surface text-text-secondary border border-border">
            Node.js ≥ 20
          </span>
          <span className="text-xs font-medium px-2.5 py-1 rounded-full bg-surface text-text-secondary border border-border">
            Apache-2.0
          </span>
          <span className="text-xs font-medium px-2.5 py-1 rounded-full bg-surface text-text-secondary border border-border">
            549 tests
          </span>
        </div>

        <div className="flex flex-col sm:flex-row items-center justify-center gap-3 sm:gap-4 mb-12 sm:mb-16">
          <Button variant="primary" href="/docs/getting-started" className="w-full sm:w-auto">
            Get Started
          </Button>
          <Button
            variant="secondary"
            href="https://github.com/flyingsquirrel0419/layercache"
            className="w-full sm:w-auto"
          >
            View on GitHub
          </Button>
        </div>
      </motion.div>

      {/* Code window */}
      <motion.div
        initial={{ opacity: 0, y: 30 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.8, delay: 0.8, ease: "easeOut" }}
        className="max-w-2xl w-full px-4 sm:px-0"
      >
        <div className="rounded-xl border border-border bg-surface overflow-hidden">
          {/* Window chrome */}
          <div className="flex items-center gap-2 px-3 sm:px-4 py-2 sm:py-3 border-b border-border">
            <div className="w-3 h-3 rounded-full bg-red-500/60"></div>
            <div className="w-3 h-3 rounded-full bg-yellow-500/60"></div>
            <div className="w-3 h-3 rounded-full bg-green-500/60"></div>
            <span className="ml-2 text-xs sm:text-sm text-text-secondary">example.ts</span>
          </div>

          {/* Code block */}
          <pre className="p-3 sm:p-4 text-xs sm:text-sm font-mono overflow-x-auto">
            <code>
              {displayedCode}
              {showCursor && (
                <span className="inline-block w-2 h-4 bg-accent ml-1 align-middle"></span>
              )}
            </code>
          </pre>
        </div>
      </motion.div>
    </section>
  );
}
