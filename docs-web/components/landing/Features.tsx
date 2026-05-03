import { AnimatedSection } from "./AnimatedSection";

const features = [
  {
    title: "Multi-layer stack",
    copy: "Memory, Redis, disk, and Memcached share one read-through interface with automatic backfill.",
    action: "Explore layers",
  },
  {
    title: "Single-flight fetches",
    copy: "Concurrent callers collapse into one fetch locally, with Redis leases for distributed coordination.",
    action: "Prevent stampedes",
  },
  {
    title: "Precise invalidation",
    copy: "Expire by tag, prefix, pattern, or namespace without throwing away stale fallback state.",
    action: "Control freshness",
  },
  {
    title: "Operational guardrails",
    copy: "Circuit breakers, timeout controls, Prometheus metrics, OpenTelemetry spans, and CLI inspection.",
    action: "Run in production",
  },
];

export function Features() {
  return (
    <section className="bg-white px-4 py-20 text-black sm:px-6">
      <div className="uber-container">
        <div className="mb-10 flex flex-col justify-between gap-4 md:flex-row md:items-end">
          <div>
            <p className="mb-3 text-sm font-medium text-[#4b4b4b]">Core system</p>
            <h2 className="max-w-2xl text-4xl font-bold leading-[1.22]">
              Compact building blocks for predictable cache behavior.
            </h2>
          </div>
          <a
            href="/docs"
            className="w-fit rounded-full bg-[#efefef] px-4 py-3 text-sm font-medium text-black transition-colors hover:bg-[#e2e2e2]"
          >
            Read docs
          </a>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          {features.map((feature, index) => (
            <AnimatedSection key={feature.title} delay={index * 0.06}>
              <article className="uber-card flex h-full flex-col justify-between p-6">
                <div>
                  <div className="mb-6 flex h-11 w-11 items-center justify-center rounded-full bg-black text-sm font-bold text-white">
                    {index + 1}
                  </div>
                  <h3 className="text-2xl font-bold leading-[1.25]">{feature.title}</h3>
                  <p className="mt-3 text-base leading-6 text-[#4b4b4b]">
                    {feature.copy}
                  </p>
                </div>
                <span className="mt-8 w-fit rounded-full bg-[#efefef] px-4 py-3 text-sm font-medium text-black">
                  {feature.action}
                </span>
              </article>
            </AnimatedSection>
          ))}
        </div>
      </div>
    </section>
  );
}
