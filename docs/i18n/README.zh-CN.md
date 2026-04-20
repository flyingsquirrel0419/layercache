<p align="center">
  <a href="../../README.md">English</a> | <a href="./README.ko.md">한국어</a> | <strong>简体中文</strong> | <a href="./README.ja.md">日本語</a> | <a href="./README.es.md">Español</a>
</p>

<p align="center">
  <img src="../../logo.png" width="520" alt="layercache logo">
</p>

<h1 align="center">layercache</h1>

<p align="center">
  <strong>Node.js 应得的多层缓存工具包。</strong><br>
  <em>堆叠内存 + Redis + 磁盘。一套 API。零缓存击穿。</em>
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
  <a href="#-功能">功能</a>&nbsp;&nbsp;|&nbsp;&nbsp;
  <a href="../api.md">API 参考</a>&nbsp;&nbsp;|&nbsp;&nbsp;
  <a href="#-集成">集成</a>&nbsp;&nbsp;|&nbsp;&nbsp;
  <a href="#-对比">对比</a>&nbsp;&nbsp;|&nbsp;&nbsp;
  <a href="../tutorial.md">教程</a>&nbsp;&nbsp;|&nbsp;&nbsp;
  <a href="../migration-guide.md">迁移指南</a>
</p>

---

## 问题所在

每个成长的 Node.js 服务都会遇到相同的缓存瓶颈：

```
纯内存缓存        --> 快，但每个实例看到的数据不同
纯 Redis 缓存     --> 共享，但每次请求都要支付网络往返开销
手动混合方案       --> 能用... 直到你需要缓存击穿保护、失效、
                    过期数据服务、可观测性和分布式一致性
```

## 解决方案

**layercache** 为你提供了一个内置生产级功能的统一多层缓存：

```
              ┌───────────────────────────────────────┐
你的应用 ---->│             layercache                │
              │                                       │
              │  L1 内存       ~0.01ms  (进程内)       │
              │      |                                │
              │  L2 Redis      ~0.5ms   (共享)         │
              │      |                                │
              │  L3 磁盘       ~2ms     (持久化)       │
              │      |                                │
              │  Fetcher       ~20ms    (仅执行一次)   │
              └───────────────────────────────────────┘

命中时  --> 从最快的层提供服务，自动回填其他层
未命中 --> fetcher 仅执行一次（即使在 100 倍并发下）
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
  new RedisLayer({ client: new Redis(), ttl: 3600 }),  // L2: 共享
])

// 透传读取(read-through)：fetcher 执行一次，所有层被填充
const user = await cache.get('user:123', () => db.findUser(123))
```

<details>
<summary><b>纯内存模式（无需 Redis）</b></summary>

```ts
const cache = new CacheStack([
  new MemoryLayer({ ttl: 60 })
])
```

</details>

<details>
<summary><b>带磁盘持久化的三层配置</b></summary>

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

## 功能

### 核心缓存

| 功能 | 说明 |
|---|---|
| **分层读取 + 自动回填** | 优先从 L1 读取；部分命中时自动填充上层 |
| **缓存击穿保护(stampede prevention)** | 同一 key 的 100 个并发请求 = fetcher 仅执行 1 次 |
| **分布式单飞(single-flight)** | 通过 Redis 锁和租约续期实现跨实例去重 |
| **批量操作** | `getMany()` / `setMany()` / `mdelete()`，层级别快速路径 |
| **`wrap()` API** | 自动推导 key 的透明函数缓存 |
| **命名空间** | 支持层级前缀的作用域缓存视图 |
| **缓存预热** | 启动时基于优先级预填充各层 |
| **负面缓存(negative caching)** | 将缓存未命中（如"用户不存在"）以短 TTL 缓存 |

### 失效与刷新

| 功能 | 说明 |
|---|---|
| **标签失效** | 删除所有层中具有给定标签的键 |
| **批量标签失效** | 支持 `any` / `all` 语义的多标签操作 |
| **通配符与前缀失效** | glob 风格和层级键模式 |
| **代际轮换(generation rotation)** | 无需扫描即可批量使命名空间失效 |
| **Stale-while-revalidate** | 返回缓存值，后台异步刷新 |
| **Stale-if-error** | 上游故障时继续提供过期数据 |
| **滑动 TTL(sliding TTL)** | 每次读取时重置频繁访问键的过期时间 |
| **自适应 TTL(adaptive TTL)** | 热点 key 的 TTL 自动递增至上限 |
| **Refresh-ahead** | 过期前主动刷新 |
| **TTL 策略** | 将过期时间对齐到日历边界（`until-midnight`、`next-hour`、自定义） |

### 弹性与运维

| 功能 | 说明 |
|---|---|
| **优雅降级(graceful degradation)** | 临时跳过失败层，保持缓存可用 |
| **熔断器(circuit breaker)** | 反复失败后停止请求故障上游 |
| **Fetcher 速率限制** | 支持全局、按 key、按 fetcher 作用域和自定义桶 |
| **写入策略** | `strict`（任一层失败则整体失败）或 `best-effort` |
| **Write-behind** | 可配置刷新间隔的批量写入 |
| **压缩** | RedisLayer 中的 gzip / brotli，可配置阈值 |
| **MessagePack** | 可插拔序列化器（JSON 默认，MessagePack 可选） |
| **持久化** | 将快照导出/导入到内存或磁盘 |

### 可观测性

| 功能 | 说明 |
|---|---|
| **指标** | 命中、未命中、获取、过期命中、熔断器跳闸等 |
| **层级延迟** | 使用 Welford 算法计算平均值、最大值和采样数 |
| **健康检查** | 每层异步健康端点，带延迟测量 |
| **事件钩子** | `hit`、`miss`、`set`、`delete`、`stale-serve`、`stampede-dedupe`、`backfill`、`warm`、`error` |
| **OpenTelemetry** | 无需方法打补丁的钩子式分布式追踪支持 |
| **Prometheus 导出器** | 包含延迟指标的指标导出 |
| **HTTP 统计处理器** | 面向仪表盘的 JSON 端点 |
| **管理 CLI** | `npx layercache stats|keys|invalidate`，适用于 Redis 缓存 |

---

## 集成

layercache 可与你正在使用的框架无缝对接：

| 框架 | 集成方式 |
|---|---|
| **Express** | `createExpressCacheMiddleware(cache, opts)` - 自动缓存响应，添加 `x-cache: HIT/MISS` 头 |
| **Fastify** | `createFastifyLayercachePlugin(cache, opts)` - 注册 `fastify.cache`，可选统计路由 |
| **Hono** | `createHonoCacheMiddleware(cache, opts)` - 边缘兼容中间件 |
| **tRPC** | `createTrpcCacheMiddleware(cache, prefix, opts)` - 过程中间件 |
| **GraphQL** | `cacheGraphqlResolver(cache, prefix, resolver, opts)` - 字段解析器包装 |
| **Next.js** | 原生支持 App Router 和 API 路由 |
| **OpenTelemetry** | `createOpenTelemetryPlugin(cache, tracer)` - 无需打补丁的事件驱动追踪 |

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

layercache 专为多实例生产环境设计：

```
  ┌───────────┐    ┌───────────┐    ┌───────────┐
  │  服务器 A   │    │  服务器 B   │    │  服务器 C   │
  │ [Memory]  │    │ [Memory]  │    │ [Memory]  │
  └─────┬─────┘    └─────┬─────┘    └─────┬─────┘
        │                │                │
        └──── Redis Pub/Sub ──────────────┘  <-- L1 失效总线
                     │
               ┌─────┴──────┐
               │   Redis    │  <-- 共享 L2 + 标签索引 + 单飞协调
               └────────────┘
```

- **Redis 单飞** - 通过分布式锁实现跨实例未命中去重
- **Redis 失效总线** - 基于 Pub/Sub 的 L1 失效通知，确保内存一致性
- **Redis 标签索引** - 支持可选分片的共享标签追踪
- **快照持久化** - 在实例间导出/导入状态

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
┌─────────────────────┬──────────────┐
│ 场景                │ 平均延迟      │
├─────────────────────┼──────────────┤
│ L1 内存命中          │   ~0.006 ms  │
│ L2 Redis 命中       │   ~0.020 ms  │
│ 无缓存（模拟 DB）    │   ~1.08  ms  │
└─────────────────────┴──────────────┘

┌─────────────────────┬────────┐
│ 并发请求数           │  100   │
│ fetcher 执行次数     │    1   │  <-- 缓存击穿保护
└─────────────────────┴────────┘
```

基准测试命令、测试数据和场景说明详见[基准测试文档](../benchmarking.md)。

---

## 对比

|  | node-cache-manager | keyv | cacheable | **layercache** |
|---|:---:|:---:|:---:|:---:|
| 自动回填的多层缓存 | 部分 | 插件 | -- | **Yes** |
| 缓存击穿保护 | -- | -- | -- | **Yes** |
| 分布式单飞 | -- | -- | -- | **Yes** |
| 标签失效 | -- | -- | Yes | **Yes** |
| 分布式标签 | -- | -- | -- | **Yes** |
| 跨服务器 L1 刷新 | -- | -- | -- | **Yes** |
| Stale-while-revalidate | -- | -- | -- | **Yes** |
| 熔断器 | -- | -- | -- | **Yes** |
| 优雅降级 | -- | -- | -- | **Yes** |
| 滑动 / 自适应 TTL | -- | -- | -- | **Yes** |
| 缓存预热 | -- | -- | -- | **Yes** |
| 持久化 / 快照 | -- | -- | -- | **Yes** |
| 压缩 | -- | -- | Yes | **Yes** |
| 管理 CLI | -- | -- | -- | **Yes** |
| TypeScript 优先 | 部分 | Yes | Yes | **Yes** |
| Wrap / 装饰器 API | Yes | -- | -- | **Yes** |
| 命名空间 | -- | Yes | Yes | **Yes** |
| 事件钩子 | Yes | Yes | Yes | **Yes** |
| 自定义层 | 部分 | -- | -- | **Yes** |

> 详见[对比指南](../comparison.md)。

---

## 文档

| 文档 | 说明 |
|---|---|
| [API 参考](../api.md) | 包含所有选项的完整 API 文档 |
| [教程](../tutorial.md) | 分步操作指南 |
| [对比指南](../comparison.md) | 与替代方案的详细功能对比 |
| [迁移指南](../migration-guide.md) | 从 node-cache-manager、keyv 或 cacheable 迁移 |
| [基准测试](../benchmarking.md) | 基准测试场景和方法论 |
| [更新日志](../../CHANGELOG.md) | 版本历史和破坏性变更 |

---

## 示例

[`examples/`](../../examples) 目录包含可直接运行的项目：

- [`express-api/`](../../examples/express-api/) - 使用分层缓存的 Express REST API
- [`nextjs-api-routes/`](../../examples/nextjs-api-routes/) - 使用 layercache 的 Next.js App Router

---

## 环境要求

- **Node.js** >= 20
- **TypeScript** >= 5.0（可选 - 完整类型支持，附带 `.d.ts`）
- **ioredis** >= 5（可选 - 仅 Redis 功能需要）

<sub>运行时依赖：`async-mutex` 和 `@msgpack/msgpack`</sub>

---

## 贡献

欢迎贡献 - Bug 修复、文档、性能优化、新适配器或 Issue 均可。

```bash
git clone https://github.com/flyingsquirrel0419/layercache
cd layercache
npm install
npm run lint && npm test && npm run build:all
```

请参阅[贡献指南](../../CONTRIBUTING.md)和[行为准则](../../CODE_OF_CONDUCT.md)。

---

## 许可证

[Apache 2.0](../../LICENSE) - 可在个人和商业项目中自由使用。

---

<p align="center">
  如果 layercache 为你节省了时间，请在 <a href="https://github.com/flyingsquirrel0419/layercache">GitHub 上点个星</a>。这有助于更多人发现这个项目。
</p>
