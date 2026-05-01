<p align="center">
  <a href="../../README.md">English</a> | <a href="./README.ko.md">한국어</a> | <a href="./README.zh-CN.md">简体中文</a> | <strong>日本語</strong> | <a href="./README.es.md">Español</a>
</p>

<p align="center">
  <img src="../../logo.png" width="520" alt="layercache logo">
</p>

<h1 align="center">layercache</h1>

<p align="center">
  <strong>100 の同時リクエスト。DB 呼び出し 1 回。常に。</strong><br>
  <em>スタンピード防止を内蔵したマルチレイヤーキャッシュ（メモリ → Redis → ディスク）。</em>
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
  <a href="https://layercache.flyingsquirrel.me">ウェブサイト</a>&nbsp;&nbsp;|&nbsp;&nbsp;
  <a href="#-クイックスタート">クイックスタート</a>&nbsp;&nbsp;|&nbsp;&nbsp;
  <a href="#-パフォーマンス">パフォーマンス</a>&nbsp;&nbsp;|&nbsp;&nbsp;
  <a href="../api.md">API リファレンス</a>&nbsp;&nbsp;|&nbsp;&nbsp;
  <a href="#-統合">統合</a>&nbsp;&nbsp;|&nbsp;&nbsp;
  <a href="#-比較">比較</a>&nbsp;&nbsp;|&nbsp;&nbsp;
  <a href="../tutorial.md">チュートリアル</a>&nbsp;&nbsp;|&nbsp;&nbsp;
  <a href="../migration-guide.md">移行ガイド</a>
</p>

---

## なぜ layercache なのか？

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

layercache は、スタンピード防止・タグ無効化・分散一貫性を内蔵した Node.js 向けマルチレイヤーキャッシュです。設定不要ですぐに使えます。

---

## クイックスタート

```bash
npm install layercache
```

```ts
import { CacheStack, MemoryLayer, RedisLayer } from 'layercache'
import Redis from 'ioredis'

const cache = new CacheStack([
  new MemoryLayer({ ttl: 60, maxSize: 1_000 }),       // L1: プロセス内
  new RedisLayer({ client: new Redis(), ttl: 3600 }),  // L2: Redis
])

// 自動で取ってきて、自動で詰めてくれる（read-through）
const user = await cache.get('user:123', () => db.findUser(123))
```

<details>
<summary><b>メモリだけでいい場合（Redis 不要）</b></summary>

```ts
const cache = new CacheStack([
  new MemoryLayer({ ttl: 60 })
])
```

</details>

<details>
<summary><b>ディスクまで 3 層にする場合</b></summary>

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

## パフォーマンス

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

ベンチマークコマンドとシナリオ説明は[ベンチマークドキュメント](../benchmarking.md)にあります。

---

## node-cache-manager からの移行

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

// スタンピード防止:  ❌
// 自動バックフィル:  ❌
// タグ無効化:        ❌
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
  new MemoryLayer({ ttl: 60 }),    // s
  new RedisLayer({
    client: new Redis(),
    ttl: 300                       // s
  })
])

// スタンピード防止:  ✅
// 自動バックフィル:  ✅
// タグ無効化:        ✅
```

</td>
</tr>
</table>

> keyv・cacheable からの完全な移行ガイドは[移行ガイド](../migration-guide.md)をどうぞ。

---

## 比較

|  | node-cache-manager | keyv | cacheable | BentoCache | **layercache** |
|---|:---:|:---:|:---:|:---:|:---:|
| 自動バックフィル付きマルチレイヤー | 部分 | プラグイン | -- | 部分 | **Yes** |
| スタンピード防止 | -- | -- | -- | 部分 | **Yes** |
| タグ無効化 | -- | Yes | Yes | Yes | **Yes** |
| TypeScript ファースト | 部分 | Yes | Yes | Yes | **Yes** |
| イベントフック | Yes | Yes | Yes | Yes | **Yes** |

<details>
<summary>全機能比較（19 項目、クリックで展開）</summary>

|  | node-cache-manager | keyv | cacheable | BentoCache | **layercache** |
|---|:---:|:---:|:---:|:---:|:---:|
| 自動バックフィル付きマルチレイヤー | 部分 | プラグイン | -- | 部分 | **Yes** |
| スタンピード防止 | -- | -- | -- | 部分 | **Yes** |
| 分散シングルフライト | -- | -- | -- | -- | **Yes** |
| タグ無効化 | -- | Yes | Yes | Yes | **Yes** |
| 分散タグ | -- | -- | -- | -- | **Yes** |
| クロスサーバー L1 フラッシュ | -- | -- | -- | Yes | **Yes** |
| Stale-while-revalidate | -- | -- | -- | Yes | **Yes** |
| サーキットブレーカー | -- | -- | -- | Yes | **Yes** |
| グレースフルデグラデーション | -- | -- | -- | Yes | **Yes** |
| スライディング / アダプティブ TTL | -- | -- | -- | -- | **Yes** |
| キャッシュウォーミング | -- | -- | -- | -- | **Yes** |
| スナップショット永続性 | -- | -- | -- | -- | **Yes** |
| 圧縮 | -- | -- | Yes | -- | **Yes** |
| 管理 CLI | -- | -- | -- | -- | **Yes** |
| TypeScript ファースト | 部分 | Yes | Yes | Yes | **Yes** |
| Wrap / デコレーター API | Yes | -- | -- | 部分 | **Yes** |
| ネームスペース | -- | Yes | Yes | Yes | **Yes** |
| イベントフック | Yes | Yes | Yes | Yes | **Yes** |
| カスタムレイヤー | 部分 | -- | -- | Yes | **Yes** |

</details>

> 詳しい比較は[比較ガイド](../comparison.md)をどうぞ。

---

## 機能

<details>
<summary><b>コアキャッシュ・無効化・レジリエンス・可観測性（クリックで展開）</b></summary>

### コアキャッシング

| 機能 | 説明 |
|---|---|
| **階層読み取り + 自動バックフィル** | L1 を先に見て、空いているレイヤーに自動で詰める |
| **スタンピード防止** | 同じキーに 100 リクエスト来ても fetcher は 1 回しか実行しない |
| **分散シングルフライト** | Redis ロックでインスタンス間の重複 fetch を排除 |
| **バルク操作** | `getMany()` / `setMany()` / `mdelete()` でまとめて処理 |
| **`wrap()` API** | 関数をくるむだけでキーを自動導出してキャッシュしてくれる |
| **ネームスペース** | 階層プレフィックスでキャッシュ領域をきれいに分けられる |
| **キャッシュウォーミング** | 起動時に優先度順にホットデータを詰めておく |
| **ネガティブキャッシュ** | 「ユーザーなし」のような結果も短い TTL でキャッシュして DB を守る |

### 無効化と鮮度

| 機能 | 説明 |
|---|---|
| **タグ無効化** | タグ一つで、全レイヤーの関連キーをまとめて削除 |
| **バッチタグ無効化** | `any` / `all` セマンティクスで複数タグを一括処理 |
| **ワイルドカード / プレフィックス無効化** | `user:*` のようなパターンマッチで範囲削除 |
| **ジェネレーションローテーション** | スキャンなしでネームスペースごと丸ごと切り替え |
| **Stale-while-revalidate** | キャッシュ値を先に返して、バックグラウンドでこっそりリフレッシュ |
| **Stale-if-error** | 上流が落ちたら期限切れデータでもとにかく返す |
| **スライディング TTL** | よく読まれるキーは読むたびに有効期限が延びる |
| **アダプティブ TTL** | 人気キーほど TTL が自動で伸びていく |
| **Refresh-ahead** | 期限切れになる前に裏でリフレッシュしておく |
| **TTL ポリシー** | 0 時ぴったり、n 時ぴったりなど、期限をカレンダー境界に合わせられる |

### レジリエンスと運用

| 機能 | 説明 |
|---|---|
| **グレースフルデグラデーション** | レイヤーが死んだら一時スキップ、キャッシュ自体は動き続ける |
| **サーキットブレーカー** | 何度も失敗する上流には自動でストップをかける |
| **Fetcher レートリミット** | グローバル / キーごと / fetcher ごとに呼び出しを制御 |
| **書き込みポリシー** | `strict`（1 レイヤーでも失敗したらロールバック）か `best-effort` |
| **Write-behind** | 書き込みをまとめて、設定間隔で一気にフラッシュ |
| **圧縮** | RedisLayer で gzip / brotli をそのまま使える |
| **MessagePack** | JSON と MessagePack を差し替え可能なシリアライザー |
| **スナップショット** | メモリやディスクに状態を保存して、いつでも復元 |

### 可観測性

| 機能 | 説明 |
|---|---|
| **メトリクス** | ヒット、ミス、フェッチ、ステールヒット、サーキットブレーカートリップをすべて追跡 |
| **レイヤー別レイテンシ** | Welford アルゴリズムで平均・最大・サンプル数を計測 |
| **ヘルスチェック** | レイヤーごとの非同期ヘルスエンドポイント、レイテンシも測れる |
| **イベントフック** | `hit`、`miss`、`set`、`delete`、`stale-serve`、`stampede-dedupe`、`backfill`、`warm`、`error` |
| **OpenTelemetry** | コードに手を入れず、イベントフックだけで分散トレーシングに接続 |
| **Prometheus エクスポーター** | レイテンシゲージ付きでメトリクスをエクスポート |
| **HTTP 統計ハンドラー** | ダッシュボードにそのまま使える JSON エンドポイント |
| **管理 CLI** | `npx layercache stats\|keys\|invalidate` |

</details>

---

## 統合

使い慣れたフレームワークに数行でつなげる：

| フレームワーク | 統合 |
|---|---|
| **Express** | `createExpressCacheMiddleware(cache, opts)` — `x-cache: HIT/MISS` ヘッダー付きでレスポンスを自動キャッシュ |
| **Fastify** | `createFastifyLayercachePlugin(cache, opts)` — `fastify.cache` プラグイン登録、統計ルートも選べる |
| **Hono** | `createHonoCacheMiddleware(cache, opts)` — エッジ環境でも動くミドルウェア |
| **tRPC** | `createTrpcCacheMiddleware(cache, prefix, opts)` — プロシージャミドルウェア |
| **GraphQL** | `cacheGraphqlResolver(cache, prefix, resolver, opts)` — フィールドリゾルバーラッパー |
| **Next.js** | App Router、API ルートでそのまま使える |
| **OpenTelemetry** | `createOpenTelemetryPlugin(cache, tracer)` — monkey-patch 不要のイベント駆動トレーシング |

<details>
<summary><b>Express の例</b></summary>

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
<summary><b>Next.js App Router の例</b></summary>

```ts
export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const data = await cache.get(`user:${params.id}`, () => db.findUser(Number(params.id)))
  return Response.json(data)
}
```

</details>

---

## 分散デプロイ

マルチインスタンスのプロダクションでも問題なし：

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

- **Redis シングルフライト** — 分散ロックでインスタンス間の重複 fetch を防止
- **Redis 無効化バス** — Pub/Sub で L1 キャッシュをリアルタイムに無効化
- **Redis タグインデックス** — 共有タグトラッキング、シャーディングも OK
- **スナップショット** — インスタンス間でキャッシュ状態をエクスポート / インポート

<details>
<summary><b>完全な分散構成</b></summary>

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

## ドキュメント

| ドキュメント | 説明 |
|---|---|
| [API リファレンス](../api.md) | すべてのオプションを網羅した完全な API ドキュメント |
| [チュートリアル](../tutorial.md) | 手を動かしながら学ぶステップバイステップガイド |
| [比較ガイド](../comparison.md) | 他のキャッシュライブラリとの詳細比較 |
| [移行ガイド](../migration-guide.md) | node-cache-manager、keyv、cacheable からの移行 |
| [ベンチマーキング](../benchmarking.md) | ベンチマークシナリオと方法論 |
| [チェンジログ](../../CHANGELOG.md) | バージョン履歴と破壊的変更 |

---

## サンプル

[`examples/`](../../examples) ディレクトリにすぐ動かせるプロジェクトがあります：

- [`express-api/`](../../examples/express-api/) — Express REST API に階層キャッシュを適用
- [`nextjs-api-routes/`](../../examples/nextjs-api-routes/) — Next.js App Router に layercache を統合

---

## 要件

- **Node.js** >= 20
- **TypeScript** >= 5.0（オプション — 型定義付き、`.d.ts` 同梱）
- **ioredis** >= 5（オプション — Redis を使わないなら不要）

<sub>ランタイム依存は `async-mutex` と `@msgpack/msgpack` のみ</sub>

---

## コントリビュート

バグ修正、ドキュメント改善、パフォーマンス最適化、新しいアダプター — なんでも歓迎。

```bash
git clone https://github.com/flyingsquirrel0419/layercache
cd layercache
npm install
npm run lint && npm test && npm run build:all
```

[コントリビュートガイド](../../CONTRIBUTING.md)と[行動規範](../../CODE_OF_CONDUCT.md)をご一読ください。

---

## ライセンス

[Apache 2.0](../../LICENSE) — 個人・商用問わず自由に使えます。

---

<p align="center">
  layercache で時間が節約できたら、<a href="https://github.com/flyingsquirrel0419/layercache">GitHub で ⭐ スター</a>をお願いします。他の人に見つけてもらいやすくなります。
</p>
