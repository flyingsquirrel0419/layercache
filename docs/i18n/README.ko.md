<p align="center">
  <a href="../../README.md">English</a> | <strong>한국어</strong> | <a href="./README.zh-CN.md">简体中文</a> | <a href="./README.ja.md">日本語</a> | <a href="./README.es.md">Español</a>
</p>

<p align="center">
  <img src="../../logo.png" width="520" alt="layercache logo">
</p>

<h1 align="center">layercache</h1>

<p align="center">
  <strong>Node.js를 위한 멀티레이어 캐싱 툴킷.</strong><br>
  <em>Memory + Redis + Disk를 하나의 API로. 스탬피드 제로.</em>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/layercache"><img src="https://img.shields.io/npm/v/layercache?color=cb3837&label=npm" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/layercache"><img src="https://img.shields.io/npm/dw/layercache?color=blue" alt="npm downloads"></a>
  <a href="../../LICENSE"><img src="https://img.shields.io/badge/license-Apache_2.0-green" alt="license"></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-first-3178C6?logo=typescript&logoColor=white" alt="TypeScript"></a>
  <img src="https://img.shields.io/badge/Node.js-%E2%89%A5_20-339933?logo=nodedotjs&logoColor=white" alt="Node.js >= 20">
  <img src="https://img.shields.io/badge/tests-467_passing-brightgreen" alt="tests">
  <a href="https://coveralls.io/github/flyingsquirrel0419/layercache?branch=main"><img src="https://coveralls.io/repos/github/flyingsquirrel0419/layercache/badge.svg?branch=main&t=20260410" alt="Coveralls"></a>
</p>

<p align="center">
  <a href="https://layercache.flyingsquirrel.me">웹사이트</a>&nbsp;&nbsp;|&nbsp;&nbsp;
  <a href="#-빠른-시작">빠른 시작</a>&nbsp;&nbsp;|&nbsp;&nbsp;
  <a href="#-기능">기능</a>&nbsp;&nbsp;|&nbsp;&nbsp;
  <a href="../api.md">API 레퍼런스</a>&nbsp;&nbsp;|&nbsp;&nbsp;
  <a href="#-통합">통합</a>&nbsp;&nbsp;|&nbsp;&nbsp;
  <a href="#-비교">비교</a>&nbsp;&nbsp;|&nbsp;&nbsp;
  <a href="../tutorial.md">튜토리얼</a>&nbsp;&nbsp;|&nbsp;&nbsp;
  <a href="../migration-guide.md">마이그레이션 가이드</a>
</p>

---

## 문제점

성장하는 모든 Node.js 서비스는 결국 같은 캐싱 한계에 부딪힙니다:

```
메모리 전용 캐시       --> 빠르지만, 각 인스턴스가 서로 다른 데이터를 봅니다
Redis 전용 캐시        --> 공유되지만, 모든 요청이 네트워크 왕복 비용을 지불합니다
직접 구현한 하이브리드  --> 잘 동작하다가... 스탬피드 방지, 무효화,
                          만료 데이터 서빙, 관측 가능성, 분산 일관성이 필요해지면 무너집니다
```

## 해결책

**layercache**는 프로덕션급 기능이 내장된 통합 멀티레이어 캐시를 제공합니다:

```
              ┌───────────────────────────────────────┐
여러분의 앱 ---->│             layercache                │
              │                                       │
              │  L1 메모리     ~0.01ms  (프로세스 내)   │
              │      |                                │
              │  L2 Redis      ~0.5ms   (공유)         │
              │      |                                │
              │  L3 디스크     ~2ms     (영속)         │
              │      |                                │
              │  Fetcher       ~20ms    (1회만 실행)   │
              └───────────────────────────────────────┘

히트 시  --> 가장 빠른 레이어에서 서빙, 나머지 레이어에 자동 채움
미스 시 --> fetcher가 1회만 실행됨 (100배 동시 요청에서도)
```

---

## 빠른 시작

```bash
npm install layercache
```

```ts
import { CacheStack, MemoryLayer, RedisLayer } from 'layercache'
import Redis from 'ioredis'

const cache = new CacheStack([
  new MemoryLayer({ ttl: 60, maxSize: 1_000 }),       // L1: 프로세스 내
  new RedisLayer({ client: new Redis(), ttl: 3600 }),  // L2: 공유
])

// 리드스루(read-through): fetcher가 1회 실행되고 모든 레이어에 채워집니다
const user = await cache.get('user:123', () => db.findUser(123))
```

<details>
<summary><b>메모리 전용 (Redis 불필요)</b></summary>

```ts
const cache = new CacheStack([
  new MemoryLayer({ ttl: 60 })
])
```

</details>

<details>
<summary><b>디스크 영속성을 포함한 3계층 설정</b></summary>

```ts
import { CacheStack, MemoryLayer, RedisLayer, DiskLayer } from 'layercache'

const cache = new CacheStack([
  new MemoryLayer({ ttl: 60, maxSize: 5_000 }),
  new RedisLayer({ client: new Redis(), ttl: 3600, compression: 'gzip' }),
  new DiskLayer({ directory: './var/cache', maxFiles: 10_000 }),
])
```

</details>

---

## 기능

### 핵심 캐싱

| 기능 | 설명 |
|---|---|
| **계층형 읽기 + 자동 백필** | L1에서 먼저 조회; 부분 히트 시 상위 레이어를 자동으로 채웁니다 |
| **스탬피드 방지(stampede prevention)** | 같은 키에 100개의 동시 요청 = fetcher 1회 실행 |
| **분산 싱글플라이트(single-flight)** | Redis 락과 리스 갱신으로 인스턴스 간 중복 제거 |
| **벌크 연산** | `getMany()` / `setMany()` / `mdelete()` — 레이어 수준 빠른 경로 제공 |
| **`wrap()` API** | 자동 키 파생으로 투명한 함수 캐싱 |
| **네임스페이스** | 계층적 프리픽스 지원으로 스코프가 지정된 캐시 뷰 |
| **캐시 워밍** | 시작 시 우선순위 기반 로딩으로 레이어 미리 채우기 |
| **네거티브 캐싱** | 캐시 미스(예: "사용자를 찾을 수 없음")를 짧은 TTL로 캐싱 |

### 무효화 및 갱신

| 기능 | 설명 |
|---|---|
| **태그 무효화** | 주어진 태그의 모든 키를 모든 레이어에서 삭제 |
| **배치 태그 무효화** | `any` / `all` 시맨틱으로 다중 태그 연산 |
| **와일드카드 및 프리픽스 무효화** | 글로브 스타일 및 계층적 키 패턴 |
| **세대 기반 교체(generation rotation)** | 스캔 없이 대량 네임스페이스 무효화 |
| **Stale-while-revalidate** | 캐시된 값을 반환하고 백그라운드에서 갱신 |
| **Stale-if-error** | 업스트림 장애 시 만료된 값을 계속 서빙 |
| **슬라이딩 TTL(sliding TTL)** | 자주 접근하는 키의 만료를 읽기 시마다 갱신 |
| **적응형 TTL(adaptive TTL)** | 핫 키의 TTL을 상한까지 자동 증가 |
| **Refresh-ahead** | 만료 전에 미리 갱신 |
| **TTL 정책** | 만료를 캘린더 경계에 맞춤 (`until-midnight`, `next-hour`, 커스텀) |

### 복원력 및 운영

| 기능 | 설명 |
|---|---|
| **우아한 성능 저하(graceful degradation)** | 실패한 레이어를 일시적으로 건너뛰고 캐시 유지 |
| **서킷 브레이커(circuit breaker)** | 반복 실패 후 고장난 업스트림에 대한 요청 중단 |
| **Fetcher 속도 제한** | 전역, 키별, fetcher별 스코프와 커스텀 버킷 |
| **쓰기 정책** | `strict` (어떤 레이어가 실패하면 전체 실패) 또는 `best-effort` |
| **Write-behind** | 설정 가능한 플러시 간격으로 쓰기 일괄 처리 |
| **압축** | RedisLayer에서 gzip / brotli (설정 가능한 임계값) |
| **MessagePack** | 플러그형 직렬화기 (JSON 기본, MessagePack 대안) |
| **영속성** | 메모리 또는 디스크로 스냅샷 내보내기/가져오기 |

### 관측 가능성

| 기능 | 설명 |
|---|---|
| **메트릭** | 히트, 미스, fetch, 스테일 히트, 서킷 브레이커 트립 등 |
| **레이어별 지연 시간** | Welford 알고리즘으로 평균, 최대, 샘플 수 측정 |
| **헬스 체크** | 레이어별 비동기 헬스 엔드포인트와 지연 시간 측정 |
| **이벤트 훅** | `hit`, `miss`, `set`, `delete`, `stale-serve`, `stampede-dedupe`, `backfill`, `warm`, `error` |
| **OpenTelemetry** | 메서드 원숭이-패칭 없이 훅 기반 분산 추적 지원 |
| **Prometheus 익스포터** | 지연 시간 게이지를 포함한 메트릭 내보내기 |
| **HTTP 통계 핸들러** | 대시보드용 JSON 엔드포인트 |
| **관리 CLI** | Redis 기반 캐시를 위한 `npx layercache stats|keys|invalidate` |

---

## 통합

layercache는 이미 사용 중인 프레임워크와 연동됩니다:

| 프레임워크 | 통합 |
|---|---|
| **Express** | `createExpressCacheMiddleware(cache, opts)` - `x-cache: HIT/MISS` 헤더로 응답 자동 캐싱 |
| **Fastify** | `createFastifyLayercachePlugin(cache, opts)` - `fastify.cache` 등록, 선택적 통계 라우트 |
| **Hono** | `createHonoCacheMiddleware(cache, opts)` - 엣지 호환 미들웨어 |
| **tRPC** | `createTrpcCacheMiddleware(cache, prefix, opts)` - 프로시저 미들웨어 |
| **GraphQL** | `cacheGraphqlResolver(cache, prefix, resolver, opts)` - 필드 리졸버 래퍼 |
| **Next.js** | App Router 및 API 라우트와 네이티브로 동작 |
| **OpenTelemetry** | `createOpenTelemetryPlugin(cache, tracer)` - 원숭이-패칭 없이 이벤트 기반 트레이싱 스팬 |

<details>
<summary><b>Express 예시</b></summary>

```ts
import { CacheStack, MemoryLayer, createExpressCacheMiddleware } from 'layercache'

const cache = new CacheStack([new MemoryLayer({ ttl: 60 })])

app.get('/api/users', createExpressCacheMiddleware(cache, {
  ttl: 30,
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

layercache는 다중 인스턴스 프로덕션 환경에 맞게 설계되었습니다:

```
  ┌───────────┐    ┌───────────┐    ┌───────────┐
  │ 서버 A     │    │ 서버 B     │    │ 서버 C     │
  │ [Memory]  │    │ [Memory]  │    │ [Memory]  │
  └─────┬─────┘    └─────┬─────┘    └─────┬─────┘
        │                │                │
        └──── Redis Pub/Sub ──────────────┘  <-- L1 무효화 버스
                     │
               ┌─────┴──────┐
               │   Redis    │  <-- 공유 L2 + 태그 인덱스 + 싱글플라이트
               └────────────┘
```

- **Redis 싱글플라이트** - 분산 락으로 인스턴스 간 미스 중복 제거
- **Redis 무효화 버스** - Pub/Sub 기반 L1 무효화로 메모리 일관성 보장
- **Redis 태그 인덱스** - 선택적 샤딩이 있는 공유 태그 추적
- **스냅샷 영속성** - 인스턴스 간 상태 내보내기/가져오기

<details>
<summary><b>전체 분산 설정</b></summary>

```ts
import {
  CacheStack, MemoryLayer, RedisLayer,
  RedisInvalidationBus, RedisTagIndex, RedisSingleFlightCoordinator
} from 'layercache'

const redis = new Redis()
const bus = new RedisInvalidationBus({ publisher: redis, subscriber: new Redis() })
const tagIndex = new RedisTagIndex({ client: redis, prefix: 'myapp:tags' })
const coordinator = new RedisSingleFlightCoordinator({ client: redis })

const cache = new CacheStack(
  [
    new MemoryLayer({ ttl: 60, maxSize: 10_000 }),
    new RedisLayer({ client: redis, ttl: 3600, prefix: 'myapp:cache:' })
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

## 성능

```
┌─────────────────────┬──────────────┐
│ 시나리오             │ 평균 지연     │
├─────────────────────┼──────────────┤
│ L1 메모리 히트       │   ~0.006 ms  │
│ L2 Redis 히트       │   ~0.020 ms  │
│ 캐시 없음 (DB 시뮬)  │   ~1.08  ms  │
└─────────────────────┴──────────────┘

┌─────────────────────┬────────┐
│ 동시 요청 수         │  100   │
│ fetcher 실행 수      │    1   │  <-- 스탬피드 방지
└─────────────────────┴────────┘
```

벤치마크 명령어, 픽스처, 시나리오 노트는 [벤치마킹 문서](../benchmarking.md)에서 확인할 수 있습니다.

---

## 비교

|  | node-cache-manager | keyv | cacheable | **layercache** |
|---|:---:|:---:|:---:|:---:|
| 자동 백필이 있는 멀티레이어 | 부분 | 플러그인 | -- | **Yes** |
| 스탬피드 방지 | -- | -- | -- | **Yes** |
| 분산 싱글플라이트 | -- | -- | -- | **Yes** |
| 태그 무효화 | -- | -- | Yes | **Yes** |
| 분산 태그 | -- | -- | -- | **Yes** |
| 크로스 서버 L1 플러시 | -- | -- | -- | **Yes** |
| Stale-while-revalidate | -- | -- | -- | **Yes** |
| 서킷 브레이커 | -- | -- | -- | **Yes** |
| 우아한 성능 저하 | -- | -- | -- | **Yes** |
| 슬라이딩 / 적응형 TTL | -- | -- | -- | **Yes** |
| 캐시 워밍 | -- | -- | -- | **Yes** |
| 영속성 / 스냅샷 | -- | -- | -- | **Yes** |
| 압축 | -- | -- | Yes | **Yes** |
| 관리 CLI | -- | -- | -- | **Yes** |
| TypeScript 퍼스트 | 부분 | Yes | Yes | **Yes** |
| Wrap / 데코레이터 API | Yes | -- | -- | **Yes** |
| 네임스페이스 | -- | Yes | Yes | **Yes** |
| 이벤트 훅 | Yes | Yes | Yes | **Yes** |
| 커스텀 레이어 | 부분 | -- | -- | **Yes** |

> 자세한 내용은 [비교 가이드](../comparison.md)를 참조하세요.

---

## 문서

| 문서 | 설명 |
|---|---|
| [API 레퍼런스](../api.md) | 모든 옵션이 포함된 완전한 API 문서 |
| [튜토리얼](../tutorial.md) | 단계별 실전 워크스루 |
| [비교 가이드](../comparison.md) | 대안과의 상세 기능 비교 |
| [마이그레이션 가이드](../migration-guide.md) | node-cache-manager, keyv, cacheable에서 마이그레이션 |
| [벤치마킹](../benchmarking.md) | 벤치마크 시나리오와 방법론 |
| [체인지로그](../../CHANGELOG.md) | 버전 히스토리와 파괴적 변경 |

---

## 예시

[`examples/`](../../examples) 디렉토리에 바로 실행 가능한 프로젝트가 있습니다:

- [`express-api/`](../../examples/express-api/) - 계층형 캐싱을 적용한 Express REST API
- [`nextjs-api-routes/`](../../examples/nextjs-api-routes/) - layercache를 적용한 Next.js App Router

---

## 요구 사항

- **Node.js** >= 20
- **TypeScript** >= 5.0 (선택 - 완전한 타입 지원, `.d.ts` 포함)
- **ioredis** >= 5 (선택 - Redis 기능에만 필요)

<sub>런타임 의존성: `async-mutex` 및 `@msgpack/msgpack`</sub>

---

## 기여

기여를 환영합니다 - 버그 수정, 문서, 성능, 새 어댑터, 이슈 모두 좋습니다.

```bash
git clone https://github.com/flyingsquirrel0419/layercache
cd layercache
npm install
npm run lint && npm test && npm run build:all
```

[기여 가이드](../../CONTRIBUTING.md)와 [행동 강령](../../CODE_OF_CONDUCT.md)을 참조하세요.

---

## 라이선스

[Apache 2.0](../../LICENSE) - 개인 및 상업 프로젝트에서 자유롭게 사용할 수 있습니다.

---

<p align="center">
  layercache가 시간을 절약해준다면, <a href="https://github.com/flyingsquirrel0419/layercache">GitHub에서 스타</a>를 눌러주세요. 다른 사람들이 프로젝트를 발견하는 데 도움이 됩니다.
</p>
