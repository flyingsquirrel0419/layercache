# 📦 cache-bridge — 프로젝트 플랜

> 메모리(L1) → Redis(L2) → DB(L3) 계층 캐시를 하나의 API로 통합하는 라이브러리

---

## 1. 프로젝트 개요

### 문제 정의

대부분의 프로덕션 서비스는 다음과 같은 문제에 직면한다:

- 인메모리 캐시만 쓰면: 서버가 여러 대일 때 캐시가 공유되지 않음
- Redis만 쓰면: 네트워크 레이턴시 발생, 아주 빈번한 조회에 비효율
- 계층 캐시를 직접 구현하면: 각 레이어의 TTL 관리, 무효화 전파, 스탬피드 방지 등 복잡한 로직을 매번 작성해야 함

### 해결책

**cache-bridge**는 여러 캐시 레이어를 하나의 통합 인터페이스로 묶어준다:

1. L1 Miss 시 L2 자동 조회
2. L2에서 찾으면 L1에 자동 채우기 (backfill)
3. L2도 Miss면 제공된 fetcher 함수 실행 후 전체 레이어에 채우기
4. 무효화 시 모든 레이어에 자동 전파
5. Cache stampede 방지 (동시 요청 중 하나만 fetcher 실행)

### 타겟 사용자

- Redis를 사용하지만 네트워크 레이턴시를 줄이고 싶은 팀
- 계층 캐시를 매 프로젝트마다 새로 구현하는 팀
- 고트래픽 서비스를 운영하는 백엔드 엔지니어

---

## 2. 기술 스펙

### 핵심 의존성

```json
{
  "dependencies": {
    "async-mutex": "^0.4.0"
  },
  "peerDependencies": {
    "ioredis": ">=5.0.0"
  },
  "optionalDependencies": {
    "ioredis": ">=5.0.0"
  },
  "devDependencies": {
    "typescript": "^5.0.0",
    "vitest": "^1.0.0",
    "tsup": "^8.0.0",
    "ioredis": "^5.3.0",
    "ioredis-mock": "^8.0.0"
  }
}
```

### 지원 환경

- Node.js >= 18
- TypeScript >= 5.0
- Redis 선택적 의존성 (메모리 캐시만도 사용 가능)
- ESM + CJS 동시 지원

---

## 3. API 설계

### 기본 사용법

```typescript
import { CacheBridge, MemoryLayer, RedisLayer } from 'cache-bridge'
import { Redis } from 'ioredis'

const redis = new Redis(process.env.REDIS_URL)

const cache = new CacheBridge([
  new MemoryLayer({ ttl: 60, maxSize: 1000 }),      // L1: 로컬 메모리 (60초)
  new RedisLayer({ client: redis, ttl: 3600 }),      // L2: Redis (1시간)
])

// 기본 get/set
await cache.set('user:123', { id: 123, name: 'Alice' })
const user = await cache.get('user:123')

// fetcher 패턴 (권장): 캐시 미스 시 자동으로 fetcher 실행 후 저장
const user = await cache.get('user:123', () => db.findUser(123))

// 타입 안전성
const user = await cache.get<User>('user:123', () => db.findUser(123))
// user: User | null
```

### 고급 기능

```typescript
// TTL 오버라이드
const user = await cache.get('user:123', () => db.findUser(123), {
  ttl: { memory: 30, redis: 600 }  // 레이어별 TTL 개별 설정
})

// 태그 기반 무효화 (관련 키 일괄 삭제)
await cache.set('user:123', userData, { tags: ['user', 'user:123'] })
await cache.set('user:123:posts', posts, { tags: ['user', 'user:123'] })

// 유저 관련 캐시 전부 삭제
await cache.invalidateByTag('user:123')

// 패턴 기반 삭제
await cache.invalidateByPattern('user:*')

// 여러 키 동시 조회 (mget)
const [user1, user2, user3] = await cache.mget([
  { key: 'user:1', fetch: () => db.findUser(1) },
  { key: 'user:2', fetch: () => db.findUser(2) },
  { key: 'user:3', fetch: () => db.findUser(3) },
])
```

### Cache Stampede 방지

```typescript
// 동일 키에 대해 동시에 100개 요청이 들어와도
// fetcher는 한 번만 실행됨 (나머지 99개는 대기)
const cache = new CacheBridge([...], {
  stampedePrevention: true,  // 기본값: true
})

// 결과: fetcher 실행 횟수가 1/100로 감소
```

### 레이어 교체 (어댑터 패턴)

```typescript
// 개발 환경: 메모리만
const devCache = new CacheBridge([
  new MemoryLayer({ ttl: 60 })
])

// 프로덕션 환경: 메모리 + Redis
const prodCache = new CacheBridge([
  new MemoryLayer({ ttl: 60 }),
  new RedisLayer({ client: redis, ttl: 3600 })
])

// 코드 변경 없이 환경에 따라 교체
export const cache = process.env.NODE_ENV === 'production' ? prodCache : devCache
```

### 커스텀 레이어 구현

```typescript
import { CacheLayer } from 'cache-bridge'

// 자체 캐시 레이어 구현 (예: Memcached, DynamoDB)
class MemcachedLayer implements CacheLayer {
  async get(key: string) { /* ... */ }
  async set(key: string, value: unknown, ttl: number) { /* ... */ }
  async delete(key: string) { /* ... */ }
  async clear() { /* ... */ }
}

const cache = new CacheBridge([
  new MemoryLayer({ ttl: 60 }),
  new MemcachedLayer({ host: 'localhost', port: 11211 }),
])
```

---

## 4. 프로젝트 구조

```
cache-bridge/
├── src/
│   ├── index.ts                   # 공개 API
│   ├── CacheBridge.ts             # 핵심 오케스트레이터
│   ├── layers/
│   │   ├── CacheLayer.ts          # 레이어 인터페이스
│   │   ├── MemoryLayer.ts         # LRU 메모리 캐시
│   │   └── RedisLayer.ts          # Redis 어댑터
│   ├── stampede/
│   │   └── StampedeGuard.ts       # Mutex 기반 stampede 방지
│   ├── invalidation/
│   │   ├── TagIndex.ts            # 태그 → 키 인덱스 관리
│   │   └── PatternMatcher.ts      # glob 패턴 매칭
│   ├── serialization/
│   │   ├── JsonSerializer.ts      # 기본 JSON 직렬화
│   │   └── MsgpackSerializer.ts   # 고성능 MessagePack 직렬화
│   └── types.ts
├── tests/
│   ├── CacheBridge.test.ts
│   ├── layers/
│   │   ├── MemoryLayer.test.ts
│   │   └── RedisLayer.test.ts     # ioredis-mock 사용
│   ├── stampede/
│   └── integration/
├── examples/
│   ├── express-api/
│   ├── nextjs-api-routes/
│   └── nestjs-module/
├── benchmarks/
│   ├── latency.ts                 # L1 vs L2 vs no-cache 레이턴시 비교
│   └── stampede.ts                # stampede 방지 효과 측정
└── package.json
```

---

## 5. 핵심 구현 코드

### CacheBridge 핵심 로직

```typescript
// src/CacheBridge.ts
export class CacheBridge {
  private stampedeGuard = new StampedeGuard()

  constructor(
    private layers: CacheLayer[],
    private options: CacheBridgeOptions = {}
  ) {}

  async get<T>(key: string, fetcher?: () => Promise<T>, options?: GetOptions): Promise<T | null> {
    // 1. 레이어 순서대로 조회
    for (let i = 0; i < this.layers.length; i++) {
      const value = await this.layers[i].get(key)
      if (value !== null) {
        // 2. 상위 레이어(더 빠른 레이어)에 backfill
        await this.backfill(key, value, i - 1, options)
        return value as T
      }
    }

    // 3. 모든 레이어 miss → fetcher 실행
    if (!fetcher) return null

    return this.stampedeGuard.execute(key, async () => {
      const value = await fetcher()
      if (value !== null && value !== undefined) {
        await this.setAll(key, value, options)
      }
      return value
    })
  }

  private async backfill(key: string, value: unknown, upToIndex: number, options?: GetOptions) {
    for (let i = 0; i <= upToIndex; i++) {
      await this.layers[i].set(key, value, this.getTtl(i, options))
    }
  }
}
```

---

## 6. 구현 단계별 로드맵

### Phase 1: 핵심 레이어 (1~2주)

- [ ] `CacheLayer` 인터페이스 정의
- [ ] `MemoryLayer` 구현 (LRU 알고리즘)
- [ ] `RedisLayer` 구현 (ioredis 기반)
- [ ] `CacheBridge` 오케스트레이터 (get/set/delete)
- [ ] Backfill 로직
- [ ] 단위 테스트

### Phase 2: 고급 기능 (2~3주)

- [ ] Cache Stampede 방지 (async-mutex)
- [ ] 태그 기반 무효화
- [ ] 패턴 기반 무효화
- [ ] `mget` / `mset` 배치 작업
- [ ] TTL 레이어별 개별 설정
- [ ] MessagePack 직렬화 지원

### Phase 3: 통합 & 관찰 가능성 (3~4주)

- [ ] NestJS 모듈 (`@cache-bridge/nestjs`)
- [ ] Next.js 예제
- [ ] 캐시 히트율 메트릭 수집
- [ ] Redis pub/sub을 통한 다중 서버 간 L1 무효화 전파
- [ ] `RedisTagIndex`를 통한 다중 서버 태그 무효화 지원
- [ ] 디버그 로거 (`cache-bridge:debug`)

### 멀티 서버 주의사항

- 메모리 기반 `TagIndex`만 사용할 경우 태그 무효화 범위는 현재 인스턴스가 추적한 키에 한정됨
- 다중 서버에서 태그 무효화를 완전하게 사용하려면 공유 Redis를 사용하는 `RedisTagIndex`를 함께 구성해야 함
- 쓰기 시 pub/sub 기반 L1 무효화 전파는 기본 활성화지만, write-heavy 서비스에서는 옵션으로 비활성화하는 것이 유리할 수 있음

### 후속 개선 후보

- `RedisTagIndex`의 `${prefix}:keys` 셋은 lazy cleanup 기반이라 장시간 운영 시 누적될 수 있음
- `matchPattern`은 현재 `knownKeys` 전체를 읽어 클라이언트에서 glob 필터링하므로, 대규모 키셋에서는 `SSCAN` 기반 증분 탐색 또는 주기적 정리 작업이 필요할 수 있음

### Phase 4: 커뮤니티 (4~6주)

- [ ] "Multi-Layer Caching Patterns in Node.js" 블로그
- [ ] 레이턴시 벤치마크 공개 (숫자로 임팩트 보여주기)
- [ ] NestJS 커뮤니티, Redis 커뮤니티 디스코드 홍보

---

## 7. 성능 목표

```
캐시 레이어별 예상 레이턴시:
  L1 (Memory):  ~0.01ms  ← 이 라이브러리로 여기서 먼저 처리
  L2 (Redis):   ~0.5ms
  No cache:     ~10~50ms (DB 조회)

Cache Stampede 방지 효과:
  적용 전: 동시 100 요청 → fetcher 100번 실행
  적용 후: 동시 100 요청 → fetcher 1번 실행, 99번은 대기 후 공유
```

---

## 8. 경쟁 분석

| 항목 | node-cache | ioredis | cache-manager | **cache-bridge** |
|------|-----------|---------|---------------|-----------------|
| 계층 캐시 | ❌ | ❌ | △ | ✅ |
| 자동 Backfill | ❌ | ❌ | ❌ | ✅ |
| Stampede 방지 | ❌ | ❌ | ❌ | ✅ |
| 태그 무효화 | ❌ | ❌ | ❌ | ✅ |
| TypeScript 퍼스트 | ❌ | ✅ | △ | ✅ |
| NestJS 통합 | ❌ | ❌ | ✅ | ✅ |

---

## 9. 성공 지표

| 지표 | 1개월 | 3개월 | 6개월 |
|------|-------|-------|-------|
| GitHub Stars | 200 | 1,000 | 4,000 |
| npm 주간 다운로드 | 3,000 | 30,000 | 150,000 |
| 컨트리뷰터 | 3 | 10 | 25 |
