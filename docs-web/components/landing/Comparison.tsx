import { AnimatedSection } from "./AnimatedSection";

const features = [
  { name: "Multi-layer stacking", layercache: true, cacheManager: false, keyv: false, cacheable: false },
  { name: "Stampede prevention", layercache: true, cacheManager: false, keyv: false, cacheable: true },
  { name: "Tag invalidation", layercache: true, cacheManager: false, keyv: false, cacheable: true },
  { name: "Pattern invalidation", layercache: true, cacheManager: false, keyv: false, cacheable: false },
  { name: "Stale-while-revalidate", layercache: true, cacheManager: true, keyv: false, cacheable: true },
  { name: "Circuit breaker", layercache: true, cacheManager: false, keyv: false, cacheable: false },
  { name: "Write-behind", layercache: true, cacheManager: false, keyv: false, cacheable: false },
  { name: "Adaptive TTL", layercache: true, cacheManager: false, keyv: false, cacheable: false },
  { name: "Generation versioning", layercache: true, cacheManager: false, keyv: false, cacheable: false },
  { name: "Negative caching", layercache: true, cacheManager: false, keyv: false, cacheable: false },
  { name: "Per-layer TTL", layercache: true, cacheManager: false, keyv: false, cacheable: false },
  { name: "Distributed single-flight", layercache: true, cacheManager: false, keyv: false, cacheable: false },
  { name: "Cross-server invalidation", layercache: true, cacheManager: false, keyv: false, cacheable: false },
  { name: "Snapshot persistence", layercache: true, cacheManager: false, keyv: false, cacheable: false },
  { name: "Memcached support", layercache: true, cacheManager: true, keyv: true, cacheable: false },
  { name: "Disk layer", layercache: true, cacheManager: false, keyv: false, cacheable: false },
  { name: "Prometheus metrics", layercache: true, cacheManager: false, keyv: false, cacheable: false },
  { name: "OpenTelemetry", layercache: true, cacheManager: false, keyv: false, cacheable: false },
  { name: "Admin CLI", layercache: true, cacheManager: false, keyv: false, cacheable: false },
];

function Cell({ supported }: { supported: boolean }) {
  if (supported) {
    return (
      <td className="py-3 px-4 text-center">
        <svg
          className="inline-block w-5 h-5 text-green-500"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <polyline points="20 6 9 17 4 12" />
        </svg>
      </td>
    );
  }
  return (
    <td className="py-3 px-4 text-center text-text-secondary/30">&mdash;</td>
  );
}

export function Comparison() {
  return (
    <AnimatedSection className="py-24 px-6">
      <div className="max-w-5xl mx-auto">
        <h2 className="text-3xl md:text-4xl font-bold text-center mb-12">
          How Layercache Compares
        </h2>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr className="sticky top-0 bg-surface">
                <th className="py-3 px-4 text-left text-sm font-semibold w-40">
                  Feature
                </th>
                <th className="py-3 px-4 text-left text-sm font-semibold w-28 text-accent font-bold">
                  Layercache
                </th>
                <th className="py-3 px-4 text-left text-sm font-semibold">
                  node-cache-manager
                </th>
                <th className="py-3 px-4 text-left text-sm font-semibold">
                  keyv
                </th>
                <th className="py-3 px-4 text-left text-sm font-semibold">
                  cacheable
                </th>
              </tr>
            </thead>
            <tbody>
              {features.map((feature) => (
                <tr
                  key={feature.name}
                  className="border-b border-border hover:bg-surface/50"
                >
                  <td className="py-3 px-4 text-sm">{feature.name}</td>
                  <Cell supported={feature.layercache} />
                  <Cell supported={feature.cacheManager} />
                  <Cell supported={feature.keyv} />
                  <Cell supported={feature.cacheable} />
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </AnimatedSection>
  );
}
