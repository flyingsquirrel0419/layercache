<p align="center">
  <a href="../../README.md">English</a> | <strong>한국어</strong> | <a href="./README.zh-CN.md">简体中文</a> | <a href="./README.ja.md">日本語</a> | <a href="./README.es.md">Español</a>
</p>

<p align="center">
  <img src="../../logo.png" width="520" alt="layercache logo">
</p>

<h1 align="center">layercache</h1>

<p align="center">
  <strong>동시 요청 100개. DB 호출 1번. 항상.</strong><br>
  <em>스탬피드 방지가 내장된 멀티 레이어 캐시 (메모리 → Redis → 디스크).</em>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/layercache"><img src="https://img.shields.io/npm/v/layercache?color=cb3837&label=npm" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/layercache"><img src="https://img.shields.io/npm/dw/layercache?color=blue" alt="npm downloads"></a>
  <a href="../../LICENSE"><img src="https://img.shields.io/badge/license-Apache_2.0-green" alt="license"></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-first-3178C6?logo=typescript&logoColor=white" alt="TypeScript"></a>
  <img src="https://img.shields.io/badge/Node.js-%E2%89%A5_20-339933?logo=nodedotjs&logoColor=white" alt="Node.js >= 20">
  <img src="https://img.shields.io/badge/tests-672_passing-brightgreen" alt="tests">
  <a href="https://coveralls.io/github/flyingsquirrel0419/layercache?branch=main"><img src="https://coveralls.io/repos/github/flyingsquirrel0419/layercache/badge.svg?branch=main&t=20260517" alt="Coveralls"></a>
</p>

<p align="center">
  <a href="https://flyingsquirrel0419.github.io/layercache">웹사이트</a>&nbsp;&nbsp;|&nbsp;&nbsp;
  <a href="#-빠른-시작">빠른 시작</a>&nbsp;&nbsp;|&nbsp;&nbsp;
  <a href="#-성능">성능</a>&nbsp;&nbsp;|&nbsp;&nbsp;
  <a href="../api.md">API 레퍼런스</a>&nbsp;&nbsp;|&nbsp;&nbsp;
  <a href="#-통합">통합</a>&nbsp;&nbsp;|&nbsp;&nbsp;
  <a href="#-비교">비교</a>&nbsp;&nbsp;|&nbsp;&nbsp;
  <a href="../tutorial.md">튜토리얼</a>&nbsp;&nbsp;|&nbsp;&nbsp;
  <a href="../migration-guide.md">마이그레이션 가이드</a>
</p>

---

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

## 빠른 시작

```bash
npm install layercache
```

```ts
import { CacheStack, MemoryLayer, RedisLayer } from 'layercache'
import Redis from 'ioredis'

const cache = new CacheStack([
  new MemoryLayer({ ttl: 60_000, maxSize: 1_000 }),       // L1: 인메모리
  new RedisLayer({ client: new Redis(), ttl: 3_600_000 }),  // L2: Redis
])

// 알아서 가져오고 알아서 채워줍니다 (read-through)
const user = await cache.get('user:123', () => db.findUser(123))
```

<details>
<summary><b>메모리만 쓰고 싶다면 (Redis 없이)</b></summary>

```ts
const cache = new CacheStack([
  new MemoryLayer({ ttl: 60_000 })
])
```

</details>

<details>
<summary><b>디스크까지 3계층으로 쓰고 싶다면</b></summary>

```ts
import { CacheStack, MemoryLayer, RedisLayer, DiskLayer } from 'layercache'

const cache = new CacheStack([
  new MemoryLayer({ ttl: 60_000, maxSize: 5_000 }),
  new RedisLayer({ client: new Redis(), ttl: 3_600_000, compression: 'gzip' }),
  new DiskLayer({ directory: './var/cache', maxFiles: 10_000 }),
])
```

</details>

---

## 성능

```
Environment: Node.js v20.20.1, Redis 7-alpine, Linux x86_64
CPU: AMD EPYC 4584PX 16-Core  |  RAM: 1.9 GB
Layers: MemoryLayer(ttl=60, maxSize=2000) + RedisLayer(ttl=300)
```

```
┌──────────────────────────────┬──────────┬──────────┬──────────┬──────────┐
│ Scenario                     │  avg ms  │  p95 ms  │  min ms  │  max ms  │
├──────────────────────────────┼──────────┼──────────┼──────────┼──────────┤
│ L1 memory hit (warm)         │   0.011  │   0.016  │   0.004  │   0.405  │
│ L1 hit in layered setup      │   0.006  │   0.007  │   0.004  │   0.077  │
│ No cache / origin fetch      │   6.844  │  11.196  │   4.683  │  11.196  │
└──────────────────────────────┴──────────┴──────────┴──────────┴──────────┘

┌──────────────────────────────┬────────────────────┐
│                              │  75 concurrent req │
├──────────────────────────────┼────────────────────┤
│ Without layercache           │  75 origin calls   │
│ With layercache              │   1 origin call    │  ← stampede prevention
└──────────────────────────────┴────────────────────┘
```

벤치마크 명령어와 시나리오 설명은 [벤치마킹 문서](../benchmarking.md)에 있습니다.

---

## node-cache-manager에서 마이그레이션하려면?

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

// 스탬피드 방지:  ❌
// 자동 백필:      ❌
// 태그 무효화:    ❌
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
  new MemoryLayer({ ttl: 60_000 }),    // ms
  new RedisLayer({
    client: new Redis(),
    ttl: 300_000                       // ms
  })
])

// 스탬피드 방지:  ✅
// 자동 백필:      ✅
// 태그 무효화:    ✅
```

</td>
</tr>
</table>

> keyv와 cacheable에 대한 전체 마이그레이션 가이드는 [마이그레이션 가이드](../migration-guide.md)를 참고하세요.

---

## 비교

|  | node-cache-manager | keyv | cacheable | BentoCache | **layercache** |
|---|:---:|:---:|:---:|:---:|:---:|
| 자동 백필 멀티레이어 | 부분 | 플러그인 | -- | 부분 | **Yes** |
| 스탬피드 방지 | -- | -- | -- | 부분 | **Yes** |
| 태그 무효화 | -- | Yes | Yes | Yes | **Yes** |
| TypeScript 퍼스트 | 부분 | Yes | Yes | Yes | **Yes** |
| 이벤트 훅 | Yes | Yes | Yes | Yes | **Yes** |

<details>
<summary>전체 비교 (19개 기능, 클릭하여 펼치기)</summary>

|  | node-cache-manager | keyv | cacheable | BentoCache | **layercache** |
|---|:---:|:---:|:---:|:---:|:---:|
| 자동 백필 멀티레이어 | 부분 | 플러그인 | -- | 부분 | **Yes** |
| 스탬피드 방지 | -- | -- | -- | 부분 | **Yes** |
| 분산 싱글플라이트 | -- | -- | -- | -- | **Yes** |
| 태그 무효화 | -- | Yes | Yes | Yes | **Yes** |
| 분산 태그 | -- | -- | -- | -- | **Yes** |
| 크로스 서버 L1 무효화 | -- | -- | -- | Yes | **Yes** |
| Stale-while-revalidate | -- | -- | -- | Yes | **Yes** |
| 서킷 브레이커 | -- | -- | -- | Yes | **Yes** |
| 장애 복구 | -- | -- | -- | Yes | **Yes** |
| 슬라이딩 / 적응형 TTL | -- | -- | -- | -- | **Yes** |
| 캐시 워밍 | -- | -- | -- | -- | **Yes** |
| 스냅샷 영속성 | -- | -- | -- | -- | **Yes** |
| 압축 | -- | -- | Yes | -- | **Yes** |
| 관리 CLI | -- | -- | -- | -- | **Yes** |
| TypeScript 퍼스트 | 부분 | Yes | Yes | Yes | **Yes** |
| Wrap / 데코레이터 API | Yes | -- | -- | 부분 | **Yes** |
| 네임스페이스 | -- | Yes | Yes | Yes | **Yes** |
| 이벤트 훅 | Yes | Yes | Yes | Yes | **Yes** |
| 커스텀 레이어 | 부분 | -- | -- | Yes | **Yes** |

</details>

> 자세히 비교하고 싶다면 [비교 가이드](../comparison.md)를 참고하세요.

---

## 기능

<details>
<summary><b>핵심 캐싱, 무효화, 복원력 및 모니터링 (클릭하여 펼치기)</b></summary>

### 핵심 캐싱

| 기능 | 한 줄 설명 |
|---|---|
| **계층형 읽기 + 자동 백필** | L1에서 먼저 찾고, 없는 레이어는 자동으로 채워줍니다 |
| **스탬피드 방지** | 같은 키에 100개 요청이 동시에 와도 fetcher는 1번만 실행됩니다 |
| **분산 싱글플라이트** | Redis 락으로 여러 인스턴스 간 중복 fetch를 막아줍니다 |
| **벌크 연산** | `getMany()` / `setMany()` / `mdelete()`로 한 번에 처리 |
| **`wrap()` API** | 함수를 감싸기만 하면 알아서 키를 만들고 캐싱합니다 |
| **네임스페이스** | 프리픽스로 캐시 영역을 깔끔하게 나눌 수 있습니다 |
| **캐시 워밍** | 시작할 때 미리 채워두어 첫 요청부터 빠르게 응답합니다 |
| **미스 캐싱** | "사용자 없음" 같은 결과도 짧은 TTL로 캐싱해서 DB를 보호합니다 |

### 무효화 및 갱신

| 기능 | 한 줄 설명 |
|---|---|
| **태그 무효화** | 태그 하나로 관련 키를 모든 레이어에서 한 번에 삭제합니다 |
| **배치 태그 무효화** | 여러 태그를 `any` / `all` 조건으로 한 번에 처리합니다 |
| **와일드카드 / 프리픽스 무효화** | `user:*` 같은 패턴으로 범위 삭제가 가능합니다 |
| **삭제 없는 만료** | 값을 지우지 않고 stale 상태로 표시해 SWR에서 계속 사용할 수 있습니다 |
| **세대 기반 무효화** | 스캔 없이 네임스페이스 전체를 통째로 갈아치웁니다 |
| **Stale-while-revalidate** | 캐시된 값을 먼저 돌려주고, 백그라운드에서 조용히 갱신합니다 |
| **Stale-if-error** | 원본이 장애 나면 만료된 데이터라도 계속 서빙합니다 |
| **슬라이딩 TTL** | 자주 읽히는 키는 읽을 때마다 만료가 연장됩니다 |
| **적응형 TTL** | 인기 있는 키일수록 TTL이 자동으로 길어집니다 |
| **Refresh-ahead** | 만료되기 전에 미리 갱신해 둡니다 |
| **TTL 정책** | 자정 맞춤, 정시 맞춤 등 만료 시점을 캘린더에 맞출 수 있습니다 |
| **컨텍스트 인식 엔트리 옵션** | 저장 직전 캐시 값에서 TTL과 태그를 동적으로 도출합니다 |

### 안정성 및 운영

| 기능 | 한 줄 설명 |
|---|---|
| **장애 복구** | 레이어에 문제가 생기면 잠시 건너뛰고, 캐시는 계속 동작합니다 |
| **서킷 브레이커** | 연속 장애가 감지되면 해당 업스트림으로의 요청을 차단합니다 |
| **Fetcher 호출 제한** | 전역 / 키별 / fetcher별로 동시 실행 수를 조절할 수 있습니다 |
| **쓰기 정책** | `strict` (하나라도 실패하면 전체 실패) 또는 `best-effort` |
| **Write-behind** | 쓰기를 모았다가 일정 주기로 한 번에 flush합니다 |
| **압축** | RedisLayer에서 gzip / brotli 압축을 지원합니다 |
| **MessagePack** | JSON 대신 MessagePack 직렬화를 쓸 수 있습니다 |
| **스냅샷** | 메모리나 디스크로 상태를 저장하고 복원할 수 있습니다 |

### 모니터링

| 기능 | 한 줄 설명 |
|---|---|
| **메트릭** | 히트, 미스, fetch, stale 히트, 서킷 브레이커 트립 등을 추적합니다 |
| **레이어별 지연 시간** | Welford 알고리즘으로 평균·최대·샘플 수를 계산합니다 |
| **헬스 체크** | 레이어별로 비동기 헬스 체크 엔드포인트를 제공합니다 |
| **이벤트 훅** | `hit`, `miss`, `set`, `delete`, `expire`, `stale-serve`, `stampede-dedupe`, `backfill`, `warm`, `error` |
| **OpenTelemetry** | 코드 수정 없이 훅만으로 분산 추적을 연동합니다 |
| **Prometheus 익스포터** | 지연 시간 게이지를 포함해 메트릭을 내보냅니다 |
| **HTTP 통계 핸들러** | 대시보드에 바로 쓸 수 있는 JSON 엔드포인트입니다 |
| **관리 CLI** | `npx layercache stats\|keys\|invalidate`로 Redis 캐시를 관리합니다 |

</details>

---

## 통합

이미 쓰고 있는 프레임워크에 몇 줄이면 붙입니다:

| 프레임워크 | 통합 |
|---|---|
| **Express** | `createExpressCacheMiddleware(cache, opts)` — `x-cache: HIT/MISS` 헤더와 함께 응답 자동 캐싱 |
| **Fastify** | `createFastifyLayercachePlugin(cache, opts)` — `fastify.cache` 플러그인 등록, 통계 라우트 선택 |
| **Hono** | `createHonoCacheMiddleware(cache, opts)` — 엣지 환경에서도 동작하는 미들웨어 |
| **tRPC** | `createTrpcCacheMiddleware(cache, prefix, opts)` — 프로시저 미들웨어 |
| **GraphQL** | `cacheGraphqlResolver(cache, prefix, resolver, opts)` — 필드 리졸버 래퍼 |
| **Next.js** | App Router, API 라우트에서 그대로 쓸 수 있습니다 |
| **OpenTelemetry** | `createOpenTelemetryPlugin(cache, tracer)` — 코드 수정 없이 이벤트 기반 트레이싱 |

<details>
<summary><b>Express 예시</b></summary>

```ts
import { CacheStack, MemoryLayer, createExpressCacheMiddleware } from 'layercache'

const cache = new CacheStack([new MemoryLayer({ ttl: 60_000 })])

app.get('/api/users', createExpressCacheMiddleware(cache, {
  ttl: 30_000,
  tags: ['users'],
  keyResolver: (req) => `users:${req.url}`
}), async (req, res) => {
  res.json(await db.getUsers())
})
```

</details>

<details>
<summary><b>Next.js App Router 예시</b></summary>

```ts
export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const data = await cache.get(`user:${params.id}`, () => db.findUser(Number(params.id)))
  return Response.json(data)
}
```

</details>

---

## 분산 배포

여러 인스턴스를 띄우는 프로덕션 환경에서도 문제없이 동작합니다:

```
  ┌───────────┐    ┌───────────┐    ┌───────────┐
  │ Server A  │    │ Server B  │    │ Server C  │
  │ [Memory]  │    │ [Memory]  │    │ [Memory]  │
  └─────┬─────┘    └─────┬─────┘    └─────┬─────┘
        │                │                │
        └──── Redis Pub/Sub ──────────────┘  <-- L1 invalidation bus
                     │
               ┌─────┴──────┐
               │   Redis    │  <-- shared L2 + tag index + single-flight
               └────────────┘
```

- **Redis 싱글플라이트** — 분산 락으로 인스턴스 간 중복 fetch를 막습니다
- **Redis 무효화 버스** — Pub/Sub으로 L1 캐시를 즉시 무효화합니다
- **Redis 태그 인덱스** — 공유 태그 추적, 샤딩도 선택 가능합니다
- **스냅샷 내보내기** — 인스턴스 간에 캐시 상태를 주고받을 수 있습니다

<details>
<summary><b>분산 환경 전체 설정</b></summary>

```ts
import {
  CacheStack, MemoryLayer, RedisLayer,
  RedisInvalidationBus, RedisTagIndex, RedisSingleFlightCoordinator
} from 'layercache'

const redis = new Redis()
const bus = new RedisInvalidationBus({
  publisher: redis,
  subscriber: new Redis(),
  signingSecret: process.env.LAYERCACHE_INVALIDATION_SECRET
})
const tagIndex = new RedisTagIndex({ client: redis, prefix: 'myapp:tags' })
const coordinator = new RedisSingleFlightCoordinator({ client: redis })

const cache = new CacheStack(
  [
    new MemoryLayer({ ttl: 60_000, maxSize: 10_000 }),
    new RedisLayer({ client: redis, ttl: 3_600_000, prefix: 'myapp:cache:' })
  ],
  {
    invalidationBus: bus,
    tagIndex: tagIndex,
    singleFlightCoordinator: coordinator,
    gracefulDegradation: { retryAfterMs: 10_000 }
  }
)
```

</details>

---

## 문서

| 문서 | 설명 |
|---|---|
| [API 레퍼런스](../api.md) | 모든 옵션을 담은 완전한 API 문서 |
| [튜토리얼](../tutorial.md) | 따라 하면서 익히는 실전 가이드 |
| [비교 가이드](../comparison.md) | 다른 캐시 라이브러리와의 상세 비교 |
| [마이그레이션 가이드](../migration-guide.md) | node-cache-manager, keyv, cacheable에서 옮겨오기 |
| [벤치마킹](../benchmarking.md) | 벤치마크 방법론과 시나리오 |
| [체인지로그](../../CHANGELOG.md) | 버전별 변경 이력과 주요 변경사항 |

---

## 예시

[`examples/`](../../examples)에 바로 실행해볼 수 있는 프로젝트가 있습니다:

- [`express-api/`](../../examples/express-api/) — Express REST API에 계층 캐시 적용하기
- [`nextjs-api-routes/`](../../examples/nextjs-api-routes/) — Next.js App Router에 layercache 연동하기

---

## 요구 사항

- **Node.js** >= 20
- **TypeScript** >= 5.0 (선택 — 타입이 다 들어있고 `.d.ts`도 포함)
- **ioredis** >= 5 (선택 — Redis 안 쓰면 필요 없습니다)

<sub>런타임 의존성은 `async-mutex`와 `@msgpack/msgpack` 딱 두 개입니다</sub>

---

## 기여

버그 수정, 문서 개선, 성능 최적화, 새 어댑터 — 모든 형태의 기여를 환영합니다.

```bash
git clone https://github.com/flyingsquirrel0419/layercache
cd layercache
npm install
npm run lint && npm test && npm run build:all
```

[기여 가이드](../../CONTRIBUTING.md)와 [행동 강령](../../CODE_OF_CONDUCT.md)을 읽어주세요.

---

## 라이선스

[Apache 2.0](../../LICENSE) — 개인이든 상용이든 자유롭게 쓰세요.

---

<p align="center">
  layercache가 도움이 되셨다면 <a href="https://github.com/flyingsquirrel0419/layercache">GitHub에서 ⭐ 스타</a>를 눌러주세요. 다른 개발자들에게도 알리는 데 큰 도움이 됩니다.
</p>
