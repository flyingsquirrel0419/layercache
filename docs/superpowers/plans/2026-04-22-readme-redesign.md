# README Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure README.md and all i18n READMEs around a stampede-first hook, add real benchmark numbers with environment context, and inline a before/after migration comparison.

**Architecture:** Docs-only change. README.md is rewritten in-place following the new section order. i18n files receive the same structural changes with translated prose preserved. Benchmark numbers come from a live `npm run bench:direct` run.

**Tech Stack:** Markdown, bash (benchmark runner), Docker (Redis container for benchmarks)

---

## File Map

| File | Change |
|---|---|
| `README.md` | Full restructure per new section order |
| `docs/i18n/README.ko.md` | Same structural changes, Korean prose preserved |
| `docs/i18n/README.zh-CN.md` | Same structural changes, Chinese prose preserved |
| `docs/i18n/README.ja.md` | Same structural changes, Japanese prose preserved |
| `docs/i18n/README.es.md` | Same structural changes, Spanish prose preserved |

---

## Task 1: Run Benchmarks and Capture Numbers

**Files:**
- Read: `benchmarks/direct.ts` (already done — outputs avgMs, p95Ms, minMs, maxMs, fetchCount per scenario)
- Read: `benchmarks/stampede.ts` (outputs concurrentRequests, fetcherExecutions)

- [ ] **Step 1: Run the direct benchmark**

```bash
npm run bench:direct 2>&1 | tee /tmp/bench-direct.txt
```

Expected: table printed to stdout with columns `mode`, `scenario`, `avgMs`, `p95Ms`, `minMs`, `maxMs`, `fetchCount`. Takes ~30–60s (starts a Docker Redis container).

- [ ] **Step 2: Run the stampede benchmark**

```bash
npm run bench:stampede 2>&1 | tee /tmp/bench-stampede.txt
```

Expected: `console.table` output with `concurrentRequests: 100` and `fetcherExecutions: 1`.

- [ ] **Step 3: Capture environment info**

```bash
node --version
docker exec layercache-bench-redis redis-server --version 2>/dev/null || echo "container stopped"
uname -m
grep -m1 "model name" /proc/cpuinfo | cut -d: -f2 | xargs
free -h | awk '/^Mem:/ {print $2}'
```

- [ ] **Step 4: Note the numbers**

From `/tmp/bench-direct.txt`, extract these rows (use actual output values):
- `layered` / `warm-hit` → avgMs and p95Ms  (this is the "L2 Redis hit" number)
- `memory` / `warm-hit` → avgMs and p95Ms  (this is the "L1 memory hit" number)
- `no-cache` / `cold-miss` → avgMs  (this is the "No cache / DB sim" number)
- `layered` / `stampede` → fetchCount over STAMPEDE_RUNS (5 runs × 75 concurrent = fetchCount should be 5)

Keep these numbers in mind for Task 2.

---

## Task 2: Rewrite README.md

**Files:**
- Modify: `README.md`

### 2a — Hero section

- [ ] **Step 1: Replace hero tagline and subtitle**

Find (lines 11–14 in current README):
```html
<p align="center">
  <strong>The multi-layer caching toolkit that Node.js deserves.</strong><br>
  <em>Stack memory + Redis + disk. One API. Zero stampedes.</em>
</p>
```

Replace with:
```html
<p align="center">
  <strong>100 concurrent requests. 1 DB call. Always.</strong><br>
  <em>Multi-layer cache (Memory → Redis → Disk) with stampede prevention built in.</em>
</p>
```

- [ ] **Step 2: Add stampede demo block after nav links (after the `---` separator, before `## The Problem`)**

Replace the entire `## The Problem` and `## The Solution` sections (current lines 39–70) with:

```markdown
## Why layercache?

```ts
// 100 concurrent requests hit an empty cache at the same time.
// Without stampede prevention, your DB gets 100 calls.
const results = await Promise.all(
  Array.from({ length: 100 }, () =>
    cache.get('user:1', () => db.findUser(1))
  )
)
// fetcherExecutions: 1  ← your DB was called exactly once
```

layercache is a multi-layer cache (Memory → Redis → Disk) for Node.js with stampede prevention, tag invalidation, and distributed consistency built in — no config required.

---
```

### 2b — Performance section (real numbers)

- [ ] **Step 3: Replace the current Performance section**

Find the current `## Performance` section (lines 279–296) and replace with the real numbers captured in Task 1. Use this template, filling in actual values from `/tmp/bench-direct.txt`:

```markdown
## Performance

```
Environment: Node <X.Y.Z>, Redis 7-alpine, Linux <arch>, <CPU model>, <RAM>
Layers: MemoryLayer(ttl=60, maxSize=2000) + RedisLayer(ttl=300)
```

```
┌──────────────────────────┬──────────┬──────────┬──────────┬──────────┐
│ Scenario                 │  avg ms  │  p95 ms  │  min ms  │  max ms  │
├──────────────────────────┼──────────┼──────────┼──────────┼──────────┤
│ L1 memory hit (warm)     │  <value> │  <value> │  <value> │  <value> │
│ L2 Redis hit (warm)      │  <value> │  <value> │  <value> │  <value> │
│ No cache / origin fetch  │  <value> │    —     │  <value> │  <value> │
└──────────────────────────┴──────────┴──────────┴──────────┴──────────┘

┌──────────────────────┬────────┐
│ concurrentRequests   │    75  │
│ fetcherExecutions    │     1  │  ← stampede prevention
└──────────────────────┴────────┘
```

Benchmark commands and full scenario notes: [docs/benchmarking.md](./docs/benchmarking.md)
```

### 2c — Migration Before/After (new inline section)

- [ ] **Step 4: Add migration section after Performance, before Comparison**

Insert this new section between Performance and Comparison:

```markdown
## Migrating from node-cache-manager?

<table>
<tr>
<th>Before</th>
<th>After</th>
</tr>
<tr>
<td>

```ts
import { caching, multiCaching }
  from 'cache-manager'
import { redisStore }
  from 'cache-manager-redis-yet'

const mem = await caching('memory', {
  max: 100,
  ttl: 60 * 1000        // ms
})
const red = await caching(redisStore, {
  url: 'redis://localhost:6379',
  ttl: 300 * 1000       // ms
})
const cache = multiCaching([mem, red])

// stampede prevention:  ❌
// auto backfill:        ❌
// tag invalidation:     ❌
```

</td>
<td>

```ts
import {
  CacheStack,
  MemoryLayer,
  RedisLayer
} from 'layercache'
import Redis from 'ioredis'

const cache = new CacheStack([
  new MemoryLayer({ ttl: 60 }),   // s
  new RedisLayer({
    client: new Redis(),
    ttl: 300                      // s
  })
])

// stampede prevention:  ✅
// auto backfill:        ✅
// tag invalidation:     ✅
```

</td>
</tr>
</table>

> Full migration guides for [keyv and cacheable](./docs/migration-guide.md).

---
```

### 2d — Comparison table (trimmed to 5 rows)

- [ ] **Step 5: Replace the Comparison section**

Replace the current `## Comparison` section with:

```markdown
## Comparison

|  | node-cache-manager | keyv | cacheable | **layercache** |
|---|:---:|:---:|:---:|:---:|
| Multi-layer + auto backfill | Partial | Plugin | -- | **Yes** |
| Stampede prevention | -- | -- | -- | **Yes** |
| Tag invalidation | -- | Yes | Yes | **Yes** |
| TypeScript-first | Partial | Yes | Yes | **Yes** |
| Event hooks | Yes | Yes | Yes | **Yes** |

<details>
<summary>Full comparison (19 features)</summary>

|  | node-cache-manager | keyv | cacheable | **layercache** |
|---|:---:|:---:|:---:|:---:|
| Multi-layer with auto backfill | Partial | Plugin | -- | **Yes** |
| Stampede prevention | -- | -- | -- | **Yes** |
| Distributed single-flight | -- | -- | -- | **Yes** |
| Tag invalidation | -- | Yes | Yes | **Yes** |
| Distributed tags | -- | -- | -- | **Yes** |
| Cross-server L1 flush | -- | -- | -- | **Yes** |
| Stale-while-revalidate | -- | -- | -- | **Yes** |
| Circuit breaker | -- | -- | -- | **Yes** |
| Graceful degradation | -- | -- | -- | **Yes** |
| Sliding / adaptive TTL | -- | -- | -- | **Yes** |
| Cache warming | -- | -- | -- | **Yes** |
| Persistence / snapshots | -- | -- | -- | **Yes** |
| Compression | -- | -- | Yes | **Yes** |
| Admin CLI | -- | -- | -- | **Yes** |
| TypeScript-first | Partial | Yes | Yes | **Yes** |
| Wrap / decorator API | Yes | -- | -- | **Yes** |
| Namespaces | -- | Yes | Yes | **Yes** |
| Event hooks | Yes | Yes | Yes | **Yes** |
| Custom layers | Partial | -- | -- | **Yes** |

</details>

> See the full [comparison guide](./docs/comparison.md) for detailed breakdowns.

---
```

### 2e — Features section (collapsible)

- [ ] **Step 6: Wrap Features section in `<details>`**

Find `## Features` and its three sub-tables (Core Caching, Invalidation & Freshness, Resilience & Operations, Observability). Wrap them all:

```markdown
## Features

<details>
<summary>Core Caching, Invalidation, Resilience & Observability (click to expand)</summary>

### Core Caching
[... existing table unchanged ...]

### Invalidation & Freshness
[... existing table unchanged ...]

### Resilience & Operations
[... existing table unchanged ...]

### Observability
[... existing table unchanged ...]

</details>

---
```

- [ ] **Step 7: Verify README renders correctly**

```bash
# Check no broken markdown (look for unclosed code fences)
grep -c '```' README.md
# Should be an even number
```

- [ ] **Step 8: Commit README**

```bash
git add README.md
git commit --author="flyingsquirrel0419 <25esihoya@gmail.com>" -m "docs: restructure README with stampede hook, real benchmarks, migration diff"
```

---

## Task 3: Update i18n READMEs

Apply the same structural changes to all four translated files. Code blocks and benchmark numbers are language-neutral and copied as-is. Translated prose sections (section headings, explanatory text) must be updated to match the new structure in the target language.

**Files:**
- Modify: `docs/i18n/README.ko.md`
- Modify: `docs/i18n/README.zh-CN.md`
- Modify: `docs/i18n/README.ja.md`
- Modify: `docs/i18n/README.es.md`

For each file, apply changes 2a through 2e in order. The content of each change is identical to README.md except:
- Section headings translated to the target language
- Inline explanatory prose translated (e.g. "layercache is a multi-layer cache…" paragraph)
- Code comments in stampede demo translated
- Migration table prose (`stampede prevention: ✅` labels) translated
- `> Full migration guides for…` note translated

### Korean (README.ko.md)

- [ ] **Step 1: Apply hero section change**

Replace Korean tagline/subtitle block with:
```html
<p align="center">
  <strong>동시 요청 100개. DB 호출 1번. 항상.</strong><br>
  <em>스탬피드 방지가 내장된 멀티 레이어 캐시 (메모리 → Redis → 디스크).</em>
</p>
```

- [ ] **Step 2: Replace "The Problem / The Solution" with "Why layercache?" block**

```markdown
## 왜 layercache인가?

```ts
// 100개의 동시 요청이 빈 캐시에 동시에 도달합니다.
// 스탬피드 방지 없이는 DB가 100번 호출됩니다.
const results = await Promise.all(
  Array.from({ length: 100 }, () =>
    cache.get('user:1', () => db.findUser(1))
  )
)
// fetcherExecutions: 1  ← DB는 정확히 한 번만 호출됩니다
```

layercache는 스탬피드 방지, 태그 무효화, 분산 일관성이 내장된 Node.js용 멀티 레이어 캐시입니다. 별도 설정 없이 바로 사용할 수 있습니다.

---
```

- [ ] **Step 3: Replace Performance section with real numbers (same table as README.md)**

Same table content as README.md. Replace the heading with `## 성능`.

- [ ] **Step 4: Add migration before/after section**

Heading: `## node-cache-manager에서 마이그레이션하려면?`

Same two-column table as README.md. Code is identical. Labels translated:
- `// stampede prevention:  ❌` → `// 스탬피드 방지:  ❌`
- `// auto backfill:        ❌` → `// 자동 백필:      ❌`
- `// tag invalidation:     ❌` → `// 태그 무효화:    ❌`
- `// stampede prevention:  ✅` → `// 스탬피드 방지:  ✅`
- `// auto backfill:        ✅` → `// 자동 백필:      ✅`
- `// tag invalidation:     ✅` → `// 태그 무효화:    ✅`

Footer: `> keyv와 cacheable에 대한 전체 마이그레이션 가이드는 [여기](../../migration-guide.md)를 참고하세요.`

- [ ] **Step 5: Replace Comparison table**

Heading: `## 비교`. Same 5-row table + `<details>` full table as README.md.

- [ ] **Step 6: Wrap Features in `<details>`**

Heading kept as-is. `<summary>` text: `핵심 캐싱, 무효화, 복원력 및 관찰 가능성 (클릭하여 펼치기)`

- [ ] **Step 7: Commit**

```bash
git add docs/i18n/README.ko.md
git commit --author="flyingsquirrel0419 <25esihoya@gmail.com>" -m "docs(ko): apply README restructure — stampede hook, benchmarks, migration diff"
```

### Chinese Simplified (README.zh-CN.md)

- [ ] **Step 1: Apply hero section change**

```html
<p align="center">
  <strong>100 个并发请求。1 次数据库调用。始终如此。</strong><br>
  <em>内置防击穿的多层缓存（内存 → Redis → 磁盘）。</em>
</p>
```

- [ ] **Step 2: Replace problem/solution with "Why layercache?" block**

Heading: `## 为什么选择 layercache？`

```ts
// 100 个并发请求同时打到空缓存。
// 没有防击穿机制，数据库会被调用 100 次。
const results = await Promise.all(
  Array.from({ length: 100 }, () =>
    cache.get('user:1', () => db.findUser(1))
  )
)
// fetcherExecutions: 1  ← 数据库只被调用了一次
```

Prose: `layercache 是一款内置防缓存击穿、标签失效与分布式一致性的 Node.js 多层缓存，无需额外配置。`

- [ ] **Step 3: Performance section**

Heading: `## 性能`. Same table as README.md.

- [ ] **Step 4: Migration section**

Heading: `## 从 node-cache-manager 迁移？`

Labels in code:
- `// 防击穿:  ❌ / ✅`
- `// 自动回填:  ❌ / ✅`
- `// 标签失效:  ❌ / ✅`

Footer: `> keyv 和 cacheable 的完整迁移指南请参阅[此处](../../migration-guide.md)。`

- [ ] **Step 5: Comparison table**

Heading: `## 对比`. Same 5-row table + `<details>`.

`<summary>` text: `完整对比（19 项功能，点击展开）`

- [ ] **Step 6: Wrap Features in `<details>`**

`<summary>` text: `核心缓存、失效、弹性与可观测性（点击展开）`

- [ ] **Step 7: Commit**

```bash
git add docs/i18n/README.zh-CN.md
git commit --author="flyingsquirrel0419 <25esihoya@gmail.com>" -m "docs(zh-CN): apply README restructure — stampede hook, benchmarks, migration diff"
```

### Japanese (README.ja.md)

- [ ] **Step 1: Apply hero section change**

```html
<p align="center">
  <strong>100 の同時リクエスト。DB 呼び出し 1 回。常に。</strong><br>
  <em>スタンピード防止を内蔵したマルチレイヤーキャッシュ（メモリ → Redis → ディスク）。</em>
</p>
```

- [ ] **Step 2: Replace problem/solution with "Why layercache?" block**

Heading: `## なぜ layercache なのか？`

```ts
// 100 件の同時リクエストが空のキャッシュに到達します。
// スタンピード防止がなければ、DB は 100 回呼び出されます。
const results = await Promise.all(
  Array.from({ length: 100 }, () =>
    cache.get('user:1', () => db.findUser(1))
  )
)
// fetcherExecutions: 1  ← DB は 1 回しか呼ばれません
```

Prose: `layercache は、スタンピード防止・タグ無効化・分散一貫性を内蔵した Node.js 向けマルチレイヤーキャッシュです。設定不要ですぐに使えます。`

- [ ] **Step 3: Performance section**

Heading: `## パフォーマンス`. Same table as README.md.

- [ ] **Step 4: Migration section**

Heading: `## node-cache-manager からの移行`

Labels in code:
- `// スタンピード防止:  ❌ / ✅`
- `// 自動バックフィル:  ❌ / ✅`
- `// タグ無効化:        ❌ / ✅`

Footer: `> keyv・cacheable からの完全な移行ガイドは[こちら](../../migration-guide.md)。`

- [ ] **Step 5: Comparison table**

Heading: `## 比較`. Same 5-row table + `<details>`.

`<summary>` text: `全機能比較（19 項目、クリックで展開）`

- [ ] **Step 6: Wrap Features in `<details>`**

`<summary>` text: `コアキャッシュ・無効化・回復力・オブザーバビリティ（クリックで展開）`

- [ ] **Step 7: Commit**

```bash
git add docs/i18n/README.ja.md
git commit --author="flyingsquirrel0419 <25esihoya@gmail.com>" -m "docs(ja): apply README restructure — stampede hook, benchmarks, migration diff"
```

### Spanish (README.es.md)

- [ ] **Step 1: Apply hero section change**

```html
<p align="center">
  <strong>100 peticiones concurrentes. 1 llamada a la BD. Siempre.</strong><br>
  <em>Caché multicapa (Memoria → Redis → Disco) con prevención de estampida integrada.</em>
</p>
```

- [ ] **Step 2: Replace problem/solution with "Why layercache?" block**

Heading: `## ¿Por qué layercache?`

```ts
// 100 peticiones concurrentes llegan a un caché vacío a la vez.
// Sin prevención de estampida, tu BD recibe 100 llamadas.
const results = await Promise.all(
  Array.from({ length: 100 }, () =>
    cache.get('user:1', () => db.findUser(1))
  )
)
// fetcherExecutions: 1  ← tu BD fue llamada exactamente una vez
```

Prose: `layercache es un caché multicapa (Memoria → Redis → Disco) para Node.js con prevención de estampida, invalidación por etiquetas y consistencia distribuida integradas, sin configuración adicional.`

- [ ] **Step 3: Performance section**

Heading: `## Rendimiento`. Same table as README.md.

- [ ] **Step 4: Migration section**

Heading: `## ¿Migrando desde node-cache-manager?`

Labels in code:
- `// prevención de estampida:  ❌ / ✅`
- `// relleno automático:       ❌ / ✅`
- `// invalidación por etiqueta: ❌ / ✅`

Footer: `> Guías de migración completas para keyv y cacheable en [docs/migration-guide.md](../../migration-guide.md).`

- [ ] **Step 5: Comparison table**

Heading: `## Comparación`. Same 5-row table + `<details>`.

`<summary>` text: `Comparación completa (19 características, clic para expandir)`

- [ ] **Step 6: Wrap Features in `<details>`**

`<summary>` text: `Caché principal, invalidación, resiliencia y observabilidad (clic para expandir)`

- [ ] **Step 7: Commit**

```bash
git add docs/i18n/README.es.md
git commit --author="flyingsquirrel0419 <25esihoya@gmail.com>" -m "docs(es): apply README restructure — stampede hook, benchmarks, migration diff"
```

---

## Task 4: Final Push

- [ ] **Step 1: Verify all commits**

```bash
git log --oneline -8
```

Expected: 5 commits (README + 4 i18n files).

- [ ] **Step 2: Push**

```bash
git push
```
