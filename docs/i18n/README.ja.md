<p align="center">
  <a href="../../README.md">English</a> | <a href="./README.ko.md">한국어</a> | <a href="./README.zh-CN.md">简体中文</a> | <strong>日本語</strong> | <a href="./README.es.md">Español</a>
</p>

<p align="center">
  <img src="../../logo.png" width="520" alt="layercache logo">
</p>

<h1 align="center">layercache</h1>

<p align="center">
  <strong>Node.js にふさわしいマルチレイヤーキャッシュツールキット。</strong><br>
  <em>メモリ + Redis + ディスクをスタック。ひとつの API。スタンピードゼロ。</em>
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
  <a href="#-機能">機能</a>&nbsp;&nbsp;|&nbsp;&nbsp;
  <a href="../api.md">API リファレンス</a>&nbsp;&nbsp;|&nbsp;&nbsp;
  <a href="#-統合">統合</a>&nbsp;&nbsp;|&nbsp;&nbsp;
  <a href="#-比較">比較</a>&nbsp;&nbsp;|&nbsp;&nbsp;
  <a href="../tutorial.md">チュートリアル</a>&nbsp;&nbsp;|&nbsp;&nbsp;
  <a href="../migration-guide.md">移行ガイド</a>
</p>

---

## 課題

成長する Node.js サービスはすべて、同じキャッシュの壁にぶつかる：

```
メモリオンリーキャッシュ     --> 高速だが、各インスタンスが異なるデータを保持
Redis オンリーキャッシュ     --> 共有されるが、リクエストごとにネットワーク往復コストが発生
手作りのハイブリッド         --> 動く... スタンピード防止、無効化、
                               期限切れデータの提供、オブザーバビリティ、分散整合性が必要になるまでは
```

## ソリューション

**layercache** は、プロダクションレベルの機能を組み込んだ統合マルチレイヤーキャッシュを提供する：

```
              ┌───────────────────────────────────────┐
あなたのアプリ ---->│             layercache                │
              │                                       │
              │  L1 メモリ     ~0.01ms  (プロセス内)     │
              │      |                                │
              │  L2 Redis      ~0.5ms   (共有)         │
              │      |                                │
              │  L3 ディスク   ~2ms     (永続的)       │
              │      |                                │
              │  Fetcher       ~20ms    (1回のみ実行)  │
              └───────────────────────────────────────┘

ヒット時  --> 最速レイヤーから提供、残りのレイヤーに自動バックフィル
ミス時 --> fetcher が1回のみ実行される（100倍の同時リクエストでも）
```

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
  new RedisLayer({ client: new Redis(), ttl: 3600 }),  // L2: 共有
])

// リードスルー(read-through): fetcher が1回実行され、全レイヤーにフィルされる
const user = await cache.get('user:123', () => db.findUser(123))
```

<details>
<summary><b>メモリオンリー（Redis 不要）</b></summary>

```ts
const cache = new CacheStack([
  new MemoryLayer({ ttl: 60 })
])
```

</details>

<details>
<summary><b>ディスク永続化を含む3層構成</b></summary>

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

## 機能

### コアキャッシング

| 機能 | 説明 |
|---|---|
| **階層型読み取り + 自動バックフィル** | L1 を先に読み取り、部分ヒット時は上層を自動フィル |
| **スタンピード防止(stampede prevention)** | 同一キーへの100の同時リクエスト = fetcher の実行は1回 |
| **分散シングルフライト(single-flight)** | Redis ロックとリース更新によるインスタンス間重複排除 |
| **バルク操作** | `getMany()` / `setMany()` / `mdelete()` — レイヤーレベルの高速パス |
| **`wrap()` API** | 自動キー導出による透過的関数キャッシング |
| **ネームスペース** | 階層プレフィックス対応のスコープ付きキャッシュビュー |
| **キャッシュウォーミング** | 起動時の優先度ベースローディングでレイヤーを事前フィル |
| **ネガティブキャッシュ** | キャッシュミス（例：「ユーザーが見つかりません」）を短い TTL でキャッシュ |

### 無効化と鮮度

| 機能 | 説明 |
|---|---|
| **タグ無効化** | 指定タグを持つすべてのキーを全レイヤーから削除 |
| **バッチタグ無効化** | `any` / `all` セマンティクスによるマルチタグ操作 |
| **ワイルドカード & プレフィックス無効化** | glob スタイルおよび階層キーパターン |
| **ジェネレーションベースローテーション** | スキャンなしでネームスペースを一括無効化 |
| **Stale-while-revalidate** | キャッシュ値を返しつつバックグラウンドでリフレッシュ |
| **Stale-if-error** | 上流障害時に期限切れデータを提供し続ける |
| **スライディング TTL(sliding TTL)** | 頻繁にアクセスされるキーの有効期限を読み取りごとにリセット |
| **アダプティブ TTL(adaptive TTL)** | ホットキーの TTL を上限まで自動増加 |
| **Refresh-ahead** | 有効期限切れ前にプロアクティブにリフレッシュ |
| **TTL ポリシー** | 有効期限をカレンダー境界に合わせる（`until-midnight`、`next-hour`、カスタム） |

### レジリエンスと運用

| 機能 | 説明 |
|---|---|
| **グレースフルデグラデーション(graceful degradation)** | 障害レイヤーを一時的にスキップし、キャッシュを利用可能に維持 |
| **サーキットブレーカー(circuit breaker)** | 繰り返しの失敗後、故障した上流へのリクエストを停止 |
| **Fetcher レートリミット** | グローバル、キー単位、fetcher 単位のスコープとカスタムバケット |
| **書き込みポリシー** | `strict`（いずれかのレイヤーが失敗すれば全体失敗）または `best-effort` |
| **Write-behind** | 設定可能なフラッシュ間隔によるバッチ書き込み |
| **圧縮** | RedisLayer での gzip / brotli（設定可能なしきい値） |
| **MessagePack** | プラグイン可能なシリアライザー（JSON デフォルト、MessagePack 代替） |
| **永続性** | メモリまたはディスクへのスナップショットのエクスポート/インポート |

### オブザーバビリティ

| 機能 | 説明 |
|---|---|
| **メトリクス** | ヒット、ミス、フェッチ、ステールヒット、サーキットブレーカートリップなど |
| **レイヤー別レイテンシ** | Welford アルゴリズムによる平均、最大、サンプル数 |
| **ヘルスチェック** | レイテンシ測定付きのレイヤー別非同期ヘルスエンドポイント |
| **イベントフック** | `hit`、`miss`、`set`、`delete`、`stale-serve`、`stampede-dedupe`、`backfill`、`warm`、`error` |
| **OpenTelemetry** | メソッドのモンキーパッチなしのフックベース分散トレーシング |
| **Prometheus エクスポーター** | レイテンシゲージを含むメトリクスエクスポート |
| **HTTP 統計ハンドラー** | ダッシュボード向け JSON エンドポイント |
| **管理 CLI** | Redis 対応キャッシュ向け `npx layercache stats|keys|invalidate` |

---

## 統合

layercache は利用中のフレームワークにプラグインできる：

| フレームワーク | 統合 |
|---|---|
| **Express** | `createExpressCacheMiddleware(cache, opts)` - `x-cache: HIT/MISS` ヘッダー付きでレスポンスを自動キャッシュ |
| **Fastify** | `createFastifyLayercachePlugin(cache, opts)` - `fastify.cache` を登録、オプションの統計ルート |
| **Hono** | `createHonoCacheMiddleware(cache, opts)` - エッジ対応ミドルウェア |
| **tRPC** | `createTrpcCacheMiddleware(cache, prefix, opts)` - プロシージャミドルウェア |
| **GraphQL** | `cacheGraphqlResolver(cache, prefix, resolver, opts)` - フィールドリゾルバーラッパー |
| **Next.js** | App Router と API ルートでネイティブ動作 |
| **OpenTelemetry** | `createOpenTelemetryPlugin(cache, tracer)` - モンキーパッチなしのイベント駆動トレーシングスパン |

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

## 分散デプロイメント

layercache はマルチインスタンスのプロダクション環境向けに設計されている：

```
  ┌───────────┐    ┌───────────┐    ┌───────────┐
  │ サーバー A  │    │ サーバー B  │    │ サーバー C  │
  │ [Memory]  │    │ [Memory]  │    │ [Memory]  │
  └─────┬─────┘    └─────┬─────┘    └─────┬─────┘
        │                │                │
        └──── Redis Pub/Sub ──────────────┘  <-- L1 無効化バス
                     │
               ┌─────┴──────┐
               │   Redis    │  <-- 共有 L2 + タグインデックス + シングルフライト
               └────────────┘
```

- **Redis シングルフライト** - 分散ロックによるインスタンス間ミス重複排除
- **Redis 無効化バス** - Pub/Sub ベースの L1 無効化でメモリ整合性を保証
- **Redis タグインデックス** - オプションのシャーディング付き共有タグトラッキング
- **スナップショット永続性** - インスタンス間での状態エクスポート/インポート

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

## パフォーマンス

```
┌─────────────────────┬──────────────┐
│ シナリオ             │ 平均レイテンシ │
├─────────────────────┼──────────────┤
│ L1 メモリヒット       │   ~0.006 ms  │
│ L2 Redis ヒット      │   ~0.020 ms  │
│ キャッシュなし(DB模擬) │   ~1.08  ms  │
└─────────────────────┴──────────────┘

┌─────────────────────┬────────┐
│ 同時リクエスト数       │  100   │
│ fetcher 実行回数      │    1   │  <-- スタンピード防止
└─────────────────────┴────────┘
```

ベンチマークコマンド、フィクスチャ、シナリオノートは[ベンチマークドキュメント](../benchmarking.md)を参照。

---

## 比較

|  | node-cache-manager | keyv | cacheable | **layercache** |
|---|:---:|:---:|:---:|:---:|
| 自動バックフィル付きマルチレイヤー | 部分 | プラグイン | -- | **Yes** |
| スタンピード防止 | -- | -- | -- | **Yes** |
| 分散シングルフライト | -- | -- | -- | **Yes** |
| タグ無効化 | -- | -- | Yes | **Yes** |
| 分散タグ | -- | -- | -- | **Yes** |
| クロスサーバー L1 フラッシュ | -- | -- | -- | **Yes** |
| Stale-while-revalidate | -- | -- | -- | **Yes** |
| サーキットブレーカー | -- | -- | -- | **Yes** |
| グレースフルデグラデーション | -- | -- | -- | **Yes** |
| スライディング / アダプティブ TTL | -- | -- | -- | **Yes** |
| キャッシュウォーミング | -- | -- | -- | **Yes** |
| 永続性 / スナップショット | -- | -- | -- | **Yes** |
| 圧縮 | -- | -- | Yes | **Yes** |
| 管理 CLI | -- | -- | -- | **Yes** |
| TypeScript ファースト | 部分 | Yes | Yes | **Yes** |
| Wrap / デコレーター API | Yes | -- | -- | **Yes** |
| ネームスペース | -- | Yes | Yes | **Yes** |
| イベントフック | Yes | Yes | Yes | **Yes** |
| カスタムレイヤー | 部分 | -- | -- | **Yes** |

> 詳細は[比較ガイド](../comparison.md)を参照。

---

## ドキュメント

| ドキュメント | 説明 |
|---|---|
| [API リファレンス](../api.md) | すべてのオプションを含む完全な API ドキュメント |
| [チュートリアル](../tutorial.md) | ステップバイステップの操作ウォークスルー |
| [比較ガイド](../comparison.md) | 代替ソリューションとの詳細な機能比較 |
| [移行ガイド](../migration-guide.md) | node-cache-manager、keyv、cacheable からの移行 |
| [ベンチマーキング](../benchmarking.md) | ベンチマークシナリオと方法論 |
| [チェンジログ](../../CHANGELOG.md) | バージョン履歴と破壊的変更 |

---

## サンプル

[`examples/`](../../examples) ディレクトリにすぐに実行できるプロジェクトが含まれている：

- [`express-api/`](../../examples/express-api/) - 階層キャッシュを使用した Express REST API
- [`nextjs-api-routes/`](../../examples/nextjs-api-routes/) - layercache を使用した Next.js App Router

---

## 要件

- **Node.js** >= 20
- **TypeScript** >= 5.0（オプション - 完全な型サポート、`.d.ts` 同梱）
- **ioredis** >= 5（オプション - Redis 機能にのみ必要）

<sub>ランタイム依存関係: `async-mutex` および `@msgpack/msgpack`</sub>

---

## コントリビュート

コントリビュートを歓迎する - バグ修正、ドキュメント、パフォーマンス改善、新しいアダプター、Issue など。

```bash
git clone https://github.com/flyingsquirrel0419/layercache
cd layercache
npm install
npm run lint && npm test && npm run build:all
```

[コントリビュートガイド](../../CONTRIBUTING.md)と[行動規範](../../CODE_OF_CONDUCT.md)を参照。

---

## ライセンス

[Apache 2.0](../../LICENSE) - 個人・商用プロジェクトで自由に利用可能。

---

<p align="center">
  layercache が時間を節約してくれたら、<a href="https://github.com/flyingsquirrel0419/layercache">GitHub でスター</a>を付けてください。他の人にプロジェクトを見つけやすくなります。
</p>
