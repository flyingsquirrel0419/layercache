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
        <span className="inline-flex h-7 min-w-7 items-center justify-center rounded-full bg-black px-2 text-xs font-medium text-white">
          yes
        </span>
      </td>
    );
  }
  return (
    <td className="px-4 py-3 text-center text-[#4b4b4b]">&mdash;</td>
  );
}

export function Comparison() {
  return (
    <AnimatedSection className="bg-white px-4 py-20 text-black sm:px-6">
      <div className="uber-container">
        <div className="mb-10 flex flex-col justify-between gap-4 md:flex-row md:items-end">
          <div>
            <p className="mb-3 text-sm font-medium text-[#4b4b4b]">Comparison</p>
            <h2 className="max-w-2xl text-4xl font-bold leading-[1.22]">
              A narrower API with a wider production surface.
            </h2>
          </div>
        </div>
        <div className="uber-card overflow-x-auto">
          <table className="w-full min-w-[760px] border-collapse">
            <thead>
              <tr className="sticky top-0 border-b border-black bg-white">
                <th className="w-48 px-4 py-4 text-left text-sm font-bold">
                  Feature
                </th>
                <th className="w-32 px-4 py-4 text-left text-sm font-bold">
                  Layercache
                </th>
                <th className="px-4 py-4 text-left text-sm font-bold">
                  node-cache-manager
                </th>
                <th className="px-4 py-4 text-left text-sm font-bold">
                  keyv
                </th>
                <th className="px-4 py-4 text-left text-sm font-bold">
                  cacheable
                </th>
              </tr>
            </thead>
            <tbody>
              {features.map((feature) => (
                <tr
                  key={feature.name}
                  className="border-b border-[#e2e2e2] last:border-b-0 hover:bg-[#f3f3f3]"
                >
                  <td className="px-4 py-3 text-sm font-medium">{feature.name}</td>
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
