<p align="center">
  <a href="../../README.md">English</a> | <a href="./README.ko.md">한국어</a> | <strong>简体中文</strong> | <a href="./README.ja.md">日本語</a> | <a href="./README.es.md">Español</a>
</p>

<p align="center">
  <img src="../../logo.png" width="520" alt="layercache logo">
</p>

<h1 align="center">layercache</h1>

<p align="center">
  <strong>Node.js 值得拥有的多层缓存工具包。</strong><br>
  <em>内存 + Redis + 磁盘一键搞定，告别缓存击穿。</em>
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
  <a href="https://layercache.flyingsquirrel.me">网站</a>&nbsp;&nbsp;|&nbsp;&nbsp;
  <a href="#-快速开始">快速开始</a>&nbsp;&nbsp;|&nbsp;&nbsp;
  <a href="#-功能一览">功能一览</a>&nbsp;&nbsp;|&nbsp;&nbsp;
  <a href="../api.md">API 参考</a>&nbsp;&nbsp;|&nbsp;&nbsp;
  <a href="#-框架集成">框架集成</a>&nbsp;&nbsp;|&nbsp;&nbsp;
  <a href="#-横向对比">横向对比</a>&nbsp;&nbsp;|&nbsp;&nbsp;
  <a href="../tutorial.md">教程</a>&nbsp;&nbsp;|&nbsp;&nbsp;
  <a href="../migration-guide.md">迁移指南</a>
</p>

---

## 你一定遇到过这个问题

每个 Node.js 服务做到一定规模，都会碰到同样的缓存瓶颈：

```
纯内存缓存       --> 快是快，但各实例数据不一致
纯 Redis 缓存    --> 虽然共享了，可每次请求都得跑一趟网络
自己拼的混合方案  --> 能跑…但等你需要缓存击穿保护、标签失效、
                    过期兜底、可观测性和分布式一致性的时候，就扛不住了
```

## layercache 怎么解决

**layercache** 是一个开箱即用的多层缓存方案，生产级功能全都给你准备好了：

```
              ┌───────────────────────────────────────┐
  your app ---->│             layercache                │
              │                                       │
              │  L1 Memory   ~0.01ms  (in-process)    │
              │      |                                │
              │  L2 Redis    ~0.5ms   (shared)        │
              │      |                                │
              │  L3 Disk     ~2ms     (persistent)    │
              │      |                                │
              │  Fetcher     ~20ms    (runs once)     │
              └───────────────────────────────────────┘

命中   --> 从最快的层拿数据，顺便把其他层也补上
未命中 --> fetcher 只跑一次（100 倍并发也一样）
```

---

## 快速开始

```bash
npm install layercache
```

```ts
import { CacheStack, MemoryLayer, RedisLayer } from 'layercache'
import Redis from 'ioredis'

const cache = new CacheStack([
  new MemoryLayer({ ttl: 60, maxSize: 1_000 }),       // L1: 进程内
  new RedisLayer({ client: new Redis(), ttl: 3600 }),  // L2: Redis
])

// 自动读取、自动回填（read-through）
const user = await cache.get('user:123', () => db.findUser(123))
```

<details>
<summary><b>只用内存就够了（不需要 Redis）</b></summary>

```ts
const cache = new CacheStack([
  new MemoryLayer({ ttl: 60 })
])
```

</details>

<details>
<summary><b>三层一起上，加上磁盘持久化</b></summary>

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

## 功能一览

### 核心缓存

| 功能 | 说明 |
|---|---|
| **分层读取 + 自动回填** | 优先查 L1，部分命中时自动把上层补齐 |
| **缓存击穿保护** | 同一个 key 来 100 个并发请求，fetcher 只执行 1 次 |
| **分布式单飞** | Redis 分布式锁 + 租约续期，跨实例去重 |
| **批量操作** | `getMany()` / `setMany()` / `mdelete()`，一次搞定 |
| **`wrap()` API** | 包一层函数就行，key 自动推导，缓存自动管理 |
| **命名空间** | 层级前缀支持，把缓存区域划分得清清楚楚 |
| **缓存预热** | 启动时按优先级把热数据先填进去 |
| **穿透缓存** | "用户不存在"这类结果也能短 TTL 缓存，保护数据库 |

### 失效与刷新

| 功能 | 说明 |
|---|---|
| **标签失效** | 一个标签，所有层的关联 key 一起删 |
| **批量标签失效** | `any` / `all` 语义，多标签一次搞定 |
| **通配符 / 前缀失效** | `user:*` 这种模式匹配，批量删除 |
| **代际轮换** | 不用扫描，整个命名空间直接换一代 |
| **Stale-while-revalidate** | 先返回缓存值，后台默默刷新 |
| **Stale-if-error** | 上游挂了？过期数据照样顶着用 |
| **滑动 TTL** | 越热门的 key，每次读取都自动续期 |
| **自适应 TTL** | 热点 key 的 TTL 自动往上涨，直到上限 |
| **Refresh-ahead** | 还没过期就开始提前刷新 |
| **TTL 策略** | 对齐到零点、整点，或者自定义日历边界 |

### 弹性与运维

| 功能 | 说明 |
|---|---|
| **优雅降级** | 某层挂了就先跳过，缓存照样用 |
| **熔断器** | 反复失败的上游自动熔断，不浪费请求 |
| **Fetcher 限流** | 全局 / 按 key / 按 fetcher，怎么限都行 |
| **写入策略** | `strict`（一层失败全部回滚）或 `best-effort` |
| **Write-behind** | 写操作攒一批再刷，可配刷新间隔 |
| **压缩** | RedisLayer 里直接开 gzip / brotli |
| **MessagePack** | 内置可插拔序列化器，JSON 和 MessagePack 随你选 |
| **持久化** | 快照导出到内存或磁盘，随时恢复 |

### 可观测性

| 功能 | 说明 |
|---|---|
| **指标采集** | 命中、未命中、fetch、过期命中、熔断跳闸，全都有 |
| **层级延迟统计** | Welford 算法算平均、最大值和采样数 |
| **健康检查** | 每层一个异步健康端点，延迟也能量 |
| **事件钩子** | `hit`、`miss`、`set`、`delete`、`stale-serve`、`stampede-dedupe`、`backfill`、`warm`、`error` |
| **OpenTelemetry** | 不改代码，通过事件钩子接入分布式追踪 |
| **Prometheus 导出器** | 延迟指标也给你导出去 |
| **HTTP 统计接口** | 给仪表盘用的 JSON 端点 |
| **管理 CLI** | `npx layercache stats\|keys\|invalidate` |

---

## 框架集成

你用什么框架，layercache 就能接什么框架：

| 框架 | 集成方式 |
|---|---|
| **Express** | `createExpressCacheMiddleware(cache, opts)` — 自动缓存响应，加 `x-cache: HIT/MISS` 头 |
| **Fastify** | `createFastifyLayercachePlugin(cache, opts)` — 注册 `fastify.cache`，可选统计路由 |
| **Hono** | `createHonoCacheMiddleware(cache, opts)` — 边缘环境也能跑的中间件 |
| **tRPC** | `createTrpcCacheMiddleware(cache, prefix, opts)` — 过程中间件 |
| **GraphQL** | `cacheGraphqlResolver(cache, prefix, resolver, opts)` — 字段解析器包装 |
| **Next.js** | App Router、API 路由原生支持 |
| **OpenTelemetry** | `createOpenTelemetryPlugin(cache, tracer)` — 不用 monkey-patch，事件驱动追踪 |

<details>
<summary><b>Express 示例</b></summary>

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
<summary><b>Next.js App Router 示例</b></summary>

```ts
export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const data = await cache.get(`user:${params.id}`, () => db.findUser(Number(params.id)))
  return Response.json(data)
}
```

</details>

---

## 分布式部署

多实例的生产环境，layercache 一样 hold 得住：

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

- **Redis 单飞** — 分布式锁保证跨实例不重复 fetch
- **Redis 失效总线** — Pub/Sub 实时同步 L1 失效
- **Redis 标签索引** — 共享标签追踪，支持分片
- **快照持久化** — 实例间导入导出缓存状态

<details>
<summary><b>完整分布式配置</b></summary>

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

## 性能

```
┌──────────────────────┬──────────────┐
│ 场景                 │ 平均延迟      │
├──────────────────────┼──────────────┤
│ L1 内存命中          │   ~0.006 ms  │
│ L2 Redis 命中        │   ~0.020 ms  │
│ 无缓存（模拟 DB）    │   ~1.08  ms  │
└──────────────────────┴──────────────┘

┌──────────────────────┬────────┐
│ 并发请求数            │  100   │
│ fetcher 执行次数      │    1   │  <-- 缓存击穿保护
└──────────────────────┴────────┘
```

基准测试命令和场景说明在[基准测试文档](../benchmarking.md)里。

---

## 横向对比

|  | node-cache-manager | keyv | cacheable | **layercache** |
|---|:---:|:---:|:---:|:---:|
| 自动回填多层缓存 | 部分 | 插件 | -- | **Yes** |
| 缓存击穿保护 | -- | -- | -- | **Yes** |
| 分布式单飞 | -- | -- | -- | **Yes** |
| 标签失效 | -- | -- | Yes | **Yes** |
| 分布式标签 | -- | -- | -- | **Yes** |
| 跨实例 L1 刷新 | -- | -- | -- | **Yes** |
| Stale-while-revalidate | -- | -- | -- | **Yes** |
| 熔断器 | -- | -- | -- | **Yes** |
| 优雅降级 | -- | -- | -- | **Yes** |
| 滑动 / 自适应 TTL | -- | -- | -- | **Yes** |
| 缓存预热 | -- | -- | -- | **Yes** |
| 快照持久化 | -- | -- | -- | **Yes** |
| 压缩 | -- | -- | Yes | **Yes** |
| 管理 CLI | -- | -- | -- | **Yes** |
| TypeScript 优先 | 部分 | Yes | Yes | **Yes** |
| Wrap / 装饰器 API | Yes | -- | -- | **Yes** |
| 命名空间 | -- | Yes | Yes | **Yes** |
| 事件钩子 | Yes | Yes | Yes | **Yes** |
| 自定义层 | 部分 | -- | -- | **Yes** |

> 详细对比看[对比指南](../comparison.md)。

---

## 文档

| 文档 | 说明 |
|---|---|
| [API 参考](../api.md) | 全部选项的完整 API 文档 |
| [教程](../tutorial.md) | 手把手带你走一遍 |
| [对比指南](../comparison.md) | 跟其他方案掰掰手腕 |
| [迁移指南](../migration-guide.md) | 从 node-cache-manager、keyv、cacheable 迁过来 |
| [基准测试](../benchmarking.md) | 测试场景和方法论 |
| [更新日志](../../CHANGELOG.md) | 版本历史和重大变更 |

---

## 示例

[`examples/`](../../examples) 目录里有拿来就能跑的项目：

- [`express-api/`](../../examples/express-api/) — Express REST API + 分层缓存
- [`nextjs-api-routes/`](../../examples/nextjs-api-routes/) — Next.js App Router + layercache

---

## 环境要求

- **Node.js** >= 20
- **TypeScript** >= 5.0（可选 — 类型齐全，自带 `.d.ts`）
- **ioredis** >= 5（可选 — 不用 Redis 就不需要）

<sub>运行时只依赖 `async-mutex` 和 `@msgpack/msgpack`</sub>

---

## 贡献

修 bug、补文档、做性能优化、写新适配器，都欢迎。

```bash
git clone https://github.com/flyingsquirrel0419/layercache
cd layercache
npm install
npm run lint && npm test && npm run build:all
```

看下[贡献指南](../../CONTRIBUTING.md)和[行为准则](../../CODE_OF_CONDUCT.md)再动手。

---

## 许可证

[Apache 2.0](../../LICENSE) — 个人商业随便用。

---

<p align="center">
  觉得 layercache 省了你的时间？去 <a href="https://github.com/flyingsquirrel0419/layercache">GitHub 给个 ⭐</a> 吧，让更多人看到。
</p>
