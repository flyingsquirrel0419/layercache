import { AnimatedSection } from "./AnimatedSection";

type Support = boolean | "partial";

type FeatureComparison = {
  name: string;
  layercache: Support;
  bentoCache: Support;
  cacheManager: Support;
  keyv: Support;
  cacheable: Support;
};

const features: FeatureComparison[] = [
  { name: "Multi-layer stacking", layercache: true, bentoCache: "partial", cacheManager: "partial", keyv: "partial", cacheable: false },
  { name: "Stampede prevention", layercache: true, bentoCache: "partial", cacheManager: false, keyv: false, cacheable: true },
  { name: "Tag invalidation", layercache: true, bentoCache: true, cacheManager: false, keyv: false, cacheable: true },
  { name: "Pattern invalidation", layercache: true, bentoCache: false, cacheManager: false, keyv: false, cacheable: false },
  { name: "Stale-while-revalidate", layercache: true, bentoCache: true, cacheManager: true, keyv: false, cacheable: true },
  { name: "Circuit breaker", layercache: true, bentoCache: true, cacheManager: false, keyv: false, cacheable: false },
  { name: "Write-behind", layercache: true, bentoCache: false, cacheManager: false, keyv: false, cacheable: false },
  { name: "Adaptive TTL", layercache: true, bentoCache: false, cacheManager: false, keyv: false, cacheable: false },
  { name: "Generation versioning", layercache: true, bentoCache: false, cacheManager: false, keyv: false, cacheable: false },
  { name: "Negative caching", layercache: true, bentoCache: false, cacheManager: false, keyv: false, cacheable: false },
  { name: "Per-layer TTL", layercache: true, bentoCache: true, cacheManager: false, keyv: false, cacheable: false },
  { name: "Distributed single-flight", layercache: true, bentoCache: false, cacheManager: false, keyv: false, cacheable: false },
  { name: "Cross-server invalidation", layercache: true, bentoCache: true, cacheManager: false, keyv: false, cacheable: false },
  { name: "Snapshot persistence", layercache: true, bentoCache: false, cacheManager: false, keyv: false, cacheable: false },
  { name: "Memcached support", layercache: true, bentoCache: false, cacheManager: true, keyv: true, cacheable: false },
  { name: "Disk layer", layercache: true, bentoCache: true, cacheManager: false, keyv: false, cacheable: false },
  { name: "Prometheus metrics", layercache: true, bentoCache: true, cacheManager: false, keyv: false, cacheable: false },
  { name: "OpenTelemetry", layercache: true, bentoCache: false, cacheManager: false, keyv: false, cacheable: false },
  { name: "Admin CLI", layercache: true, bentoCache: false, cacheManager: false, keyv: false, cacheable: false },
];

function Cell({ supported }: { supported: Support }) {
  if (supported === true) {
    return (
      <td className="py-3 px-4 text-center">
        <span className="inline-flex h-7 min-w-7 items-center justify-center rounded-full bg-black px-2 text-xs font-medium text-white">
          yes
        </span>
      </td>
    );
  }

  if (supported === "partial") {
    return (
      <td className="py-3 px-4 text-center">
        <span className="inline-flex h-7 min-w-7 items-center justify-center rounded-full bg-[#efefef] px-2 text-xs font-medium text-black">
          partial
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
          <table className="w-full min-w-[900px] border-collapse">
            <thead>
              <tr className="sticky top-0 border-b border-black bg-white">
                <th className="w-48 px-4 py-4 text-left text-sm font-bold">
                  Feature
                </th>
                <th className="w-32 px-4 py-4 text-left text-sm font-bold">
                  Layercache
                </th>
                <th className="px-4 py-4 text-left text-sm font-bold">
                  BentoCache
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
                  <Cell supported={feature.bentoCache} />
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
