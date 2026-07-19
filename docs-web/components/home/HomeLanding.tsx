"use client";

import { Link } from "@rspress/core/theme-original";
import { ScrollJourney } from "./ScrollJourney";
import styles from "./home.module.css";

const CAPABILITIES = [
  {
    tag: "stack",
    title: "Multi-layer stack",
    detail:
      "Memory, Redis, disk, and Memcached share one read-through interface with automatic backfill.",
    link: "/docs/layers",
  },
  {
    tag: "flight",
    title: "Single-flight fetches",
    detail:
      "Concurrent callers collapse into one fetch locally, with Redis leases for distributed coordination.",
    link: "/docs/resilience",
  },
  {
    tag: "tags",
    title: "Precise invalidation",
    detail:
      "Expire by tag, prefix, pattern, or namespace without throwing away stale fallback state.",
    link: "/docs/invalidation",
  },
  {
    tag: "ops",
    title: "Operational guardrails",
    detail:
      "Circuit breakers, timeout controls, Prometheus metrics, OpenTelemetry spans, and CLI inspection.",
    link: "/docs/observability",
  },
  {
    tag: "adapters",
    title: "Framework integrations",
    detail:
      "Middleware and helpers for Express, Fastify, Hono, tRPC, GraphQL, and OpenTelemetry.",
    link: "/docs/integrations",
  },
  {
    tag: "sandbox",
    title: "Browser playground",
    detail:
      "Run real layercache examples in a worker-based sandbox, right inside this site.",
    link: "/playground",
  },
];

function QuickStartCode() {
  const kw = styles.tokKeyword;
  const str = styles.tokString;
  const num = styles.tokNumber;
  const fn = styles.tokFn;
  const cm = styles.tokComment;
  return (
    <pre className={styles.code}>
      <code>
        <span className={kw}>import</span> {"{ CacheStack, MemoryLayer, RedisLayer }"} <span className={kw}>from</span> <span className={str}>'layercache'</span>{"\n"}
        <span className={kw}>import</span> Redis <span className={kw}>from</span> <span className={str}>'ioredis'</span>{"\n\n"}
        <span className={kw}>const</span> cache = <span className={kw}>new</span> <span className={fn}>CacheStack</span>([{"\n"}
        {"  "}<span className={kw}>new</span> <span className={fn}>MemoryLayer</span>({"{ ttl: "}<span className={num}>60_000</span>{", maxSize: "}<span className={num}>1_000</span>{" }"}),{"       "}<span className={cm}>// L1: in-process</span>{"\n"}
        {"  "}<span className={kw}>new</span> <span className={fn}>RedisLayer</span>({"{ client: "}<span className={kw}>new</span> <span className={fn}>Redis</span>(){", ttl: "}<span className={num}>3_600_000</span>{" }"}),{"  "}<span className={cm}>// L2: shared</span>{"\n"}
        ]){"\n\n"}
        <span className={cm}>{"// Read-through: fetcher runs once, all layers filled"}</span>{"\n"}
        <span className={kw}>const</span> user = <span className={kw}>await</span> cache.<span className={fn}>get</span>(<span className={str}>'user:123'</span>, () {"=>"} db.<span className={fn}>findUser</span>(<span className={num}>123</span>))
      </code>
    </pre>
  );
}

export function HomeLanding() {
  return (
    <main className={styles.landing}>
      <ScrollJourney />

      <section className={styles.section}>
        <p className={styles.sectionEyebrow}>capabilities</p>
        <h2 className={styles.sectionTitle}>Production concerns, already handled.</h2>
        <div className={styles.cards}>
          {CAPABILITIES.map((cap) => (
            <Link key={cap.tag} className={styles.card} href={cap.link}>
              <span className={styles.cardTag}>{cap.tag}</span>
              <h3 className={styles.cardTitle}>{cap.title}</h3>
              <p className={styles.cardDetail}>{cap.detail}</p>
              <span className={styles.cardMore}>Read the docs →</span>
            </Link>
          ))}
        </div>
      </section>

      <section className={styles.section}>
        <p className={styles.sectionEyebrow}>quick start</p>
        <h2 className={styles.sectionTitle}>Two layers in nine lines.</h2>
        <div className={styles.codeWrap}>
          <QuickStartCode />
        </div>
      </section>

      <section className={styles.footerCta}>
        <h2 className={styles.footerTitle}>Put a cache stack in front of it.</h2>
        <div className={styles.actions}>
          <Link className={styles.ctaPrimary} href="/docs/getting-started">
            Get started
          </Link>
          <a
            className={styles.ctaGhost}
            href="https://github.com/flyingsquirrel0419/layercache"
            target="_blank"
            rel="noreferrer"
          >
            GitHub
          </a>
        </div>
        <p className={styles.footerNote}>Apache-2.0 · 672 tests passing · Node.js ≥ 20</p>
      </section>
    </main>
  );
}
