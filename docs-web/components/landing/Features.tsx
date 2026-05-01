import { AnimatedSection } from "./AnimatedSection";

export function Features() {
  return (
    <section className="py-24 px-6">
      <div className="max-w-6xl mx-auto">
        <h2 className="text-3xl md:text-4xl font-bold text-center mb-16">
          Everything You Need for Production Caching
        </h2>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          <AnimatedSection delay={0}>
            <div className="p-6 rounded-xl border border-border bg-surface hover:border-accent/50 transition-colors duration-300 h-full flex flex-col">
              <div className="w-12 h-12 rounded-lg bg-accent/10 flex items-center justify-center mb-4">
                <svg
                  width="24"
                  height="24"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  className="text-accent"
                >
                  <rect x="4" y="14" width="16" height="6" rx="1" />
                  <rect x="6" y="8" width="12" height="6" rx="1" />
                  <rect x="8" y="2" width="8" height="6" rx="1" />
                </svg>
              </div>
              <h3 className="text-lg font-semibold mb-2">Multi-Layer Stacking</h3>
              <p className="text-text-secondary text-sm leading-relaxed">
                Stack memory, Redis, disk, and Memcached behind a single API.
                Automatic backfill across layers.
              </p>
            </div>
          </AnimatedSection>

          <AnimatedSection delay={0.1}>
            <div className="p-6 rounded-xl border border-border bg-surface hover:border-accent/50 transition-colors duration-300 h-full flex flex-col">
              <div className="w-12 h-12 rounded-lg bg-accent/10 flex items-center justify-center mb-4">
                <svg
                  width="24"
                  height="24"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  className="text-accent"
                >
                  <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                </svg>
              </div>
              <h3 className="text-lg font-semibold mb-2">Stampede Prevention</h3>
              <p className="text-text-secondary text-sm leading-relaxed">
                Shared in-flight promises collapse concurrent callers on the
                same key. Distributed single-flight via Redis leases with
                automatic renewal.
              </p>
            </div>
          </AnimatedSection>

          <AnimatedSection delay={0.2}>
            <div className="p-6 rounded-xl border border-border bg-surface hover:border-accent/50 transition-colors duration-300 h-full flex flex-col">
              <div className="w-12 h-12 rounded-lg bg-accent/10 flex items-center justify-center mb-4">
                <svg
                  width="24"
                  height="24"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  className="text-accent"
                >
                  <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z" />
                  <line x1="7" y1="7" x2="7.01" y2="7" />
                </svg>
              </div>
              <h3 className="text-lg font-semibold mb-2">Tag Invalidation</h3>
              <p className="text-text-secondary text-sm leading-relaxed">
                Invalidate by tag, pattern, or prefix. Trie-backed index for
                efficient lookups. Distributed invalidation via Redis pub/sub.
              </p>
            </div>
          </AnimatedSection>

          <AnimatedSection delay={0.3}>
            <div className="p-6 rounded-xl border border-border bg-surface hover:border-accent/50 transition-colors duration-300 h-full flex flex-col">
              <div className="w-12 h-12 rounded-lg bg-accent/10 flex items-center justify-center mb-4">
                <svg
                  width="24"
                  height="24"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  className="text-accent"
                >
                  <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                  <path d="M3 3v5h5" />
                  <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" />
                  <path d="M16 21h5v-5" />
                </svg>
              </div>
              <h3 className="text-lg font-semibold mb-2">
                Stale-While-Revalidate
              </h3>
              <p className="text-text-secondary text-sm leading-relaxed">
                Serve stale data while refreshing in the background.
                Configurable freshness windows per layer.
              </p>
            </div>
          </AnimatedSection>

          <AnimatedSection delay={0.4}>
            <div className="p-6 rounded-xl border border-border bg-surface hover:border-accent/50 transition-colors duration-300 h-full flex flex-col">
              <div className="w-12 h-12 rounded-lg bg-accent/10 flex items-center justify-center mb-4">
                <svg
                  width="24"
                  height="24"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  className="text-accent"
                >
                  <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
                </svg>
              </div>
              <h3 className="text-lg font-semibold mb-2">Circuit Breaker</h3>
              <p className="text-text-secondary text-sm leading-relaxed">
                Auto-open after consecutive failures. Graceful degradation
                preserves local single-flight when distributed coordinators
                falter.
              </p>
            </div>
          </AnimatedSection>

          <AnimatedSection delay={0.5}>
            <div className="p-6 rounded-xl border border-border bg-surface hover:border-accent/50 transition-colors duration-300 h-full flex flex-col">
              <div className="w-12 h-12 rounded-lg bg-accent/10 flex items-center justify-center mb-4">
                <svg
                  width="24"
                  height="24"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  className="text-accent"
                >
                  <circle cx="6" cy="6" r="3" />
                  <circle cx="18" cy="18" r="3" />
                  <line x1="8.5" y1="8.5" x2="15.5" y2="15.5" />
                </svg>
              </div>
              <h3 className="text-lg font-semibold mb-2">
                Distributed Single-Flight
              </h3>
              <p className="text-text-secondary text-sm leading-relaxed">
                Cross-process request deduplication via Redis. Lease-based
                locking with automatic renewal.
              </p>
            </div>
          </AnimatedSection>
        </div>
      </div>
    </section>
  );
}
