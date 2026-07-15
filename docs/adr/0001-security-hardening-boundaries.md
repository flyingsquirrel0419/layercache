# ADR 0001: Bound security-sensitive cache coordination state

- Status: Accepted
- Date: 2026-07-16
- Scope: PR #101 follow-up hardening

## Context and module map

`CacheStack` coordinates reads, writes, invalidation, generation rotation, and resilience policies across user-provided `CacheLayer` implementations. The security-sensitive paths changed here are:

| Module | Responsibility | Downstream effect |
|---|---|---|
| `CacheStackLayerWriter` | Builds layer entries and executes single/bulk writes | Remote and local cache contents |
| `CacheStackMaintenance` | Owns epochs, per-key ordering, write-behind queues, and cleanup scheduling | Stale-write exclusion and retained memory |
| `CacheKeyDiscovery` / `CacheStackGeneration` | Streams old-generation keys | Cleanup work and memory bounds |
| `CacheKeySerialization` | Canonicalizes `wrap()` arguments | Cache identity and compatibility |
| `FetchRateLimiter` | Schedules scoped fetch queues | Cross-key latency isolation |
| HTTP integrations and CLI | Convert external input into cache keys or destructive scans | Credential handling and operator safety |
| Playground worker source | Runs untrusted documentation examples | Browser message trust boundary |

The runtime is TypeScript on Node.js and edge-compatible JavaScript. Vitest fake timers and controlled layers exercise ordering windows deterministically; Redis integration tests verify the real distributed adapters.

## Decision: one finite write-ordering boundary

[Decision Log]
- 목적과 의도: Prevent delayed single, bulk, or write-behind work from repopulating invalidated keys or deleting values written by newer operations.
- 기존 구현 및 제약 조건: Single-key writes had per-key chains, bulk writes bypassed them, write-behind batches ran concurrently, and chains retained unbounded key and promise state under stalled backends.
- 검토한 주요 대안: Keep separate single/bulk locks; use one global mutex; serialize only cleanup; share per-key tails with finite admission.
- 선택한 방식: Every single and bulk write joins the same sorted per-key tail set, rechecks its epoch after backend completion, and performs layer-scoped cleanup before releasing the tail. Global, active-key, and per-key admission limits reject excess work.
- 다른 대안 대신 이 방식을 선택한 이유: A global mutex removes useful cross-key concurrency, while separate locks or asynchronous cleanup leave the reviewed overtaking windows open. Per-key tails preserve unrelated-key concurrency and make cleanup part of the ordered operation.
- 장점, 단점 및 영향: Stale writes and cleanup cannot overtake newer writes, and retained state is finite. Overloaded callers can receive `CacheWriteSaturationError`, and overlapping multi-key operations may wait for all touched keys.

## Decision: monotonic epochs and bounded generation discovery

[Decision Log]
- 목적과 의도: Keep invalidation fences sound after maintenance pruning and keep old-generation cleanup memory finite.
- 기존 구현 및 제약 조건: Per-key counters restarted from zero after pruning, creating an ABA token reuse window. Streaming cleanup still retained an unbounded de-duplication `Set` across layers.
- 검토한 주요 대안: Never prune epochs; retain tombstones; use random tokens; use monotonic tokens plus an absent-key token; disable cross-layer de-duplication; cap discovered keys.
- 선택한 방식: Allocate process-monotonic key tokens, rotate the shared absent-key token whenever entries are pruned, and advance the clear epoch on numeric rollover. Generation cleanup defaults `maxMatches` to 10,000 unique keys.
- 다른 대안 대신 이 방식을 선택한 이유: Tombstones and no pruning are unbounded, random tokens complicate deterministic testing, and removing de-duplication can repeat destructive work across layers. Rotating the absent token conservatively invalidates pending work without retaining each pruned key.
- 장점, 단점 및 영향: Pruning cannot make a stale operation current again and cleanup memory has a documented ceiling. A cleanup above the ceiling stops with a warning after bounded progress; deployments may choose a different finite limit or explicitly opt out.

## Decision: version and protect canonical cache identities

[Decision Log]
- 목적과 의도: Keep native structured values distinct from attacker-controlled plain objects and prevent query credentials from entering implicit HTTP cache identity.
- 기존 구현 및 제약 조건: Native values were represented with forgeable `$type` objects, and the sensitive query list omitted OAuth client credentials. Existing ambiguous structured keys may already contain poisoned values.
- 검토한 주요 대안: Add an escaping layer; use a binary serializer; validate only top-level values; reserve native tags recursively and rotate the schema prefix.
- 선택한 방식: Reject reserved native `$type` tags in every plain object, emit structured key parts with `j2:`, and classify `client_secret`, `client_assertion`, and `client_assertion_type` as sensitive for both Express and Hono.
- 다른 대안 대신 이 방식을 선택한 이유: Recursive reservation closes nested collisions with a small auditable change. Prefix rotation ensures old ambiguous entries are cold misses instead of trusting previously generated keys.
- 장점, 단점 및 영향: Canonical identities are unambiguous and OAuth credentials bypass implicit caching. Structured argument caches experience a one-time cold rotation, and domain objects using reserved tags need a custom `keyResolver`.

## Decision: keep shared schedulers and playground authority isolated

[Decision Log]
- 목적과 의도: Preserve per-key rate-limit independence, require explicit intent for cache-wide CLI deletion, and prevent user playground code from forging trusted worker completion messages.
- 기존 구현 및 제약 조건: A later shared timer could delay a ready bucket, only the exact `*` pattern required `--force`, and the token-bearing sender was reachable as a worker global through `Function()`.
- 검토한 주요 대안: One timer per bucket; parse glob coverage; ban `Function()` only by shadowing; isolate the trusted sender lexically and retain one preemptible timer.
- 선택한 방식: Replace a shared drain timer when a new earlier deadline arrives, classify every pattern made only from `*` and `?` as destructive, and wrap worker internals in an IIFE so the trusted sender and original `postMessage` are lexical.
- 다른 대안 대신 이 방식을 선택한 이유: A preemptible shared timer preserves bounded timer state, wildcard-only classification directly captures whole-keyspace patterns, and lexical authority remains unavailable even when dynamically constructed code reaches globals.
- 장점, 단점 및 영향: Independent keys are not delayed by another bucket, destructive CLI intent is explicit, and forged playground completion messages are rejected. The worker sandbox remains defense in depth rather than a general-purpose secure JavaScript VM.

## Verification and operations

Use the same gates as CI and the release package:

```bash
npm run lint
npm run build
npm run test:coverage
npm run test:integration
npm pack --dry-run
```

Focused regression tests cover HTTP key bypass, generation limits, epoch pruning, stale single/bulk/write-behind races, write saturation, canonical type-tag collisions, rate-limit timer preemption, wildcard-only CLI guards, and playground message forgery.
