<p align="center">
  <a href="../../README.md">English</a> | <a href="./README.ko.md">한국어</a> | <a href="./README.zh-CN.md">简体中文</a> | <a href="./README.ja.md">日本語</a> | <strong>Español</strong>
</p>

<p align="center">
  <img src="../../logo.png" width="520" alt="layercache logo">
</p>

<h1 align="center">layercache</h1>

<p align="center">
  <strong>100 peticiones concurrentes. 1 llamada a la BD. Siempre.</strong><br>
  <em>Caché multicapa (Memoria → Redis → Disco) con prevención de estampida integrada.</em>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/layercache"><img src="https://img.shields.io/npm/v/layercache?color=cb3837&label=npm" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/layercache"><img src="https://img.shields.io/npm/dw/layercache?color=blue" alt="npm downloads"></a>
  <a href="../../LICENSE"><img src="https://img.shields.io/badge/license-Apache_2.0-green" alt="license"></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-first-3178C6?logo=typescript&logoColor=white" alt="TypeScript"></a>
  <img src="https://img.shields.io/badge/Node.js-%E2%89%A5_20-339933?logo=nodedotjs&logoColor=white" alt="Node.js >= 20">
  <img src="https://img.shields.io/badge/tests-598_passing-brightgreen" alt="tests">
  <a href="https://coveralls.io/github/flyingsquirrel0419/layercache?branch=main"><img src="https://coveralls.io/repos/github/flyingsquirrel0419/layercache/badge.svg?branch=main&t=20260517" alt="Coveralls"></a>
</p>

<p align="center">
  <a href="https://flyingsquirrel0419.github.io/layercache">Sitio web</a>&nbsp;&nbsp;|&nbsp;&nbsp;
  <a href="#-inicio-rápido">Inicio rápido</a>&nbsp;&nbsp;|&nbsp;&nbsp;
  <a href="#-rendimiento">Rendimiento</a>&nbsp;&nbsp;|&nbsp;&nbsp;
  <a href="../api.md">Referencia API</a>&nbsp;&nbsp;|&nbsp;&nbsp;
  <a href="#-integraciones">Integraciones</a>&nbsp;&nbsp;|&nbsp;&nbsp;
  <a href="#-comparación">Comparación</a>&nbsp;&nbsp;|&nbsp;&nbsp;
  <a href="../tutorial.md">Tutorial</a>&nbsp;&nbsp;|&nbsp;&nbsp;
  <a href="../migration-guide.md">Guía de migración</a>
</p>

---

## ¿Por qué layercache?

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

layercache es un caché multicapa (Memoria → Redis → Disco) para Node.js con prevención de estampida, invalidación por etiquetas y consistencia distribuida integradas, sin configuración adicional.

---

## Inicio rápido

```bash
npm install layercache
```

```ts
import { CacheStack, MemoryLayer, RedisLayer } from 'layercache'
import Redis from 'ioredis'

const cache = new CacheStack([
  new MemoryLayer({ ttl: 60_000, maxSize: 1_000 }),       // L1: en proceso
  new RedisLayer({ client: new Redis(), ttl: 3_600_000 }),  // L2: Redis
])

// Lee y rellena automáticamente (read-through)
const user = await cache.get('user:123', () => db.findUser(123))
```

<details>
<summary><b>Solo memoria (sin Redis)</b></summary>

```ts
const cache = new CacheStack([
  new MemoryLayer({ ttl: 60_000 })
])
```

</details>

<details>
<summary><b>Tres capas con persistencia en disco</b></summary>

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

## Rendimiento

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

Los comandos de benchmark, fixtures y escenarios están en la [doc de benchmarks](../benchmarking.md).

---

## ¿Migrando desde node-cache-manager?

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

// prevención de estampida:     ❌
// relleno automático:          ❌
// invalidación por etiqueta:   ❌
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

// prevención de estampida:     ✅
// relleno automático:          ✅
// invalidación por etiqueta:   ✅
```

</td>
</tr>
</table>

> Guías de migración completas para keyv y cacheable en [docs/migration-guide.md](../migration-guide.md).

---

## Comparación

|  | node-cache-manager | keyv | cacheable | BentoCache | **layercache** |
|---|:---:|:---:|:---:|:---:|:---:|
| Multicapa con autorrelleno | Parcial | Plugin | -- | Parcial | **Yes** |
| Prevención de estampidas | -- | -- | -- | Parcial | **Yes** |
| Invalidación por tags | -- | Yes | Yes | Yes | **Yes** |
| TypeScript-first | Parcial | Yes | Yes | Yes | **Yes** |
| Hooks de eventos | Yes | Yes | Yes | Yes | **Yes** |

<details>
<summary>Comparación completa (19 características, clic para expandir)</summary>

|  | node-cache-manager | keyv | cacheable | BentoCache | **layercache** |
|---|:---:|:---:|:---:|:---:|:---:|
| Multicapa con autorrelleno | Parcial | Plugin | -- | Parcial | **Yes** |
| Prevención de avalanchas | -- | -- | -- | Parcial | **Yes** |
| Single-flight distribuido | -- | -- | -- | -- | **Yes** |
| Invalidación por tags | -- | Yes | Yes | Yes | **Yes** |
| Tags distribuidos | -- | -- | -- | -- | **Yes** |
| Flush L1 entre servidores | -- | -- | -- | Yes | **Yes** |
| Stale-while-revalidate | -- | -- | -- | Yes | **Yes** |
| Circuit breaker | -- | -- | -- | Yes | **Yes** |
| Degradación elegante | -- | -- | -- | Yes | **Yes** |
| TTL deslizante / adaptativo | -- | -- | -- | -- | **Yes** |
| Calentamiento de caché | -- | -- | -- | -- | **Yes** |
| Persistencia / snapshots | -- | -- | -- | -- | **Yes** |
| Compresión | -- | -- | Yes | -- | **Yes** |
| CLI de administración | -- | -- | -- | -- | **Yes** |
| TypeScript-first | Parcial | Yes | Yes | Yes | **Yes** |
| API Wrap / decorador | Yes | -- | -- | Parcial | **Yes** |
| Namespaces | -- | Yes | Yes | Yes | **Yes** |
| Hooks de eventos | Yes | Yes | Yes | Yes | **Yes** |
| Capas personalizadas | Parcial | -- | -- | Yes | **Yes** |

</details>

> Para un desglose detallado, consulta la [guía de comparación](../comparison.md).

---

## Funcionalidades

<details>
<summary><b>Caché principal, invalidación, resiliencia y observabilidad (clic para expandir)</b></summary>

### Caché principal

| Funcionalidad | Qué hace |
|---|---|
| **Lecturas en capas + autorrelleno** | Busca primero en L1; si falta en alguna capa, la rellena automáticamente |
| **Prevención de avalanchas** | 100 requests concurrentes para la misma clave = 1 sola ejecución del fetcher |
| **Single-flight distribuido** | Deduplica misses entre instancias con locks de Redis |
| **Operaciones en lote** | `getMany()` / `setMany()` / `mdelete()` para procesar de golpe |
| **API `wrap()`** | Envuelve una función y ya — la clave se genera sola y se cachea |
| **Namespaces** | Prefijos jerárquicos para separar zonas de caché |
| **Calentamiento** | Pre-llena las capas al arrancar, priorizando lo más importante |
| **Caché de misses** | Resultados como "usuario no encontrado" también se cachean con TTL corto |

### Invalidación y frescura

| Funcionalidad | Qué hace |
|---|---|
| **Invalidación por tags** | Un tag, y se borran todas las claves asociadas en todas las capas |
| **Invalidación batch de tags** | Varios tags de una vez con semántica `any` / `all` |
| **Comodines y prefijos** | `user:*` y listo, borra todo lo que coincida |
| **Expirar sin borrar** | Marca valores como stale sin eliminarlos para que SWR pueda seguir sirviéndolos |
| **Rotación por generaciones** | Cambia toda una generación de namespace sin escanear nada |
| **Stale-while-revalidate** | Devuelve lo cacheado y refresca de fondo |
| **Stale-if-error** | Si el origen falla, sigue sirviendo lo expirado sin pestañear |
| **TTL deslizante** | Cada lectura renueva la expiración de las claves populares |
| **TTL adaptativo** | Las claves calientes ven su TTL crecer automáticamente |
| **Refresh-ahead** | Refresca antes de que expire, sin que nadie lo pida |
| **Políticas de TTL** | Alinea expiraciones a medianoche, a la hora en punto, o como quieras |
| **Opciones de entrada contextuales** | Deriva TTLs y tags del valor cacheado justo antes de almacenarlo |

### Resiliencia y operaciones

| Funcionalidad | Qué hace |
|---|---|
| **Degradación elegante** | Si una capa falla, se salta temporalmente y la caché sigue funcionando |
| **Circuit breaker** | Deja de mandar requests al upstream que viene fallando |
| **Rate limit del fetcher** | Límites globales, por clave o por fetcher, con buckets configurables |
| **Políticas de escritura** | `strict` (si una capa falla, todo falla) o `best-effort` |
| **Write-behind** | Acumula escrituras y las flush de golpe cada N milisegundos |
| **Compresión** | gzip / brotli en RedisLayer, con umbral configurable |
| **MessagePack** | Serializadores intercambiables: JSON por defecto, MessagePack como alternativa |
| **Snapshots** | Exporta e importa el estado de la caché a memoria o disco |

### Observabilidad

| Funcionalidad | Qué hace |
|---|---|
| **Métricas** | Hits, misses, fetches, stale hits, trips del circuit breaker y más |
| **Latencia por capa** | Promedio, máximo y muestras con el algoritmo de Welford |
| **Health checks** | Endpoint de salud asíncrono por capa, con medición de latencia |
| **Hooks de eventos** | `hit`, `miss`, `set`, `delete`, `expire`, `stale-serve`, `stampede-dedupe`, `backfill`, `warm`, `error` |
| **OpenTelemetry** | Trazado distribuido vía hooks, sin tocar el código fuente |
| **Exportador Prometheus** | Métricas listas para scrape, incluyendo gauges de latencia |
| **Handler HTTP de stats** | Endpoint JSON para dashboards |
| **CLI de administración** | `npx layercache stats\|keys\|invalidate` |

</details>

---

## Integraciones

Se conecta con los frameworks que ya estás usando:

| Framework | Integración |
|---|---|
| **Express** | `createExpressCacheMiddleware(cache, opts)` — cachea respuestas con header `x-cache: HIT/MISS` |
| **Fastify** | `createFastifyLayercachePlugin(cache, opts)` — plugin `fastify.cache`, ruta de stats opcional |
| **Hono** | `createHonoCacheMiddleware(cache, opts)` — middleware compatible con edge |
| **tRPC** | `createTrpcCacheMiddleware(cache, prefix, opts)` — middleware de procedimiento |
| **GraphQL** | `cacheGraphqlResolver(cache, prefix, resolver, opts)` — wrapper de resolver |
| **Next.js** | Funciona nativamente con App Router y API routes |
| **OpenTelemetry** | `createOpenTelemetryPlugin(cache, tracer)` — trazado basado en eventos, sin monkey-patching |

<details>
<summary><b>Ejemplo con Express</b></summary>

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
<summary><b>Ejemplo con Next.js App Router</b></summary>

```ts
export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const data = await cache.get(`user:${params.id}`, () => db.findUser(Number(params.id)))
  return Response.json(data)
}
```

</details>

---

## Despliegues distribuidos

Diseñado para producción con múltiples instancias:

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

- **Single-flight con Redis** — locks distribuidos para deduplicar misses entre instancias
- **Bus de invalidación Redis** — invalidación L1 en tiempo real vía Pub/Sub
- **Índice de tags Redis** — tags compartidos con sharding opcional
- **Snapshots** — exportar e importar estado entre instancias

<details>
<summary><b>Configuración distribuida completa</b></summary>

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

## Documentación

| Documento | Descripción |
|---|---|
| [Referencia API](../api.md) | Documentación completa con todas las opciones |
| [Tutorial](../tutorial.md) | Guía paso a paso para ponerlo en marcha |
| [Guía de comparación](../comparison.md) | Comparación detallada con alternativas |
| [Guía de migración](../migration-guide.md) | Migrar desde node-cache-manager, keyv o cacheable |
| [Benchmarks](../benchmarking.md) | Escenarios y metodología |
| [Changelog](../../CHANGELOG.md) | Historial de versiones y cambios importantes |

---

## Ejemplos

El directorio [`examples/`](../../examples) tiene proyectos listos para ejecutar:

- [`express-api/`](../../examples/express-api/) — API REST con Express y caché en capas
- [`nextjs-api-routes/`](../../examples/nextjs-api-routes/) — Next.js App Router con layercache

---

## Requisitos

- **Node.js** >= 20
- **TypeScript** >= 5.0 (opcional — totalmente tipado, incluye `.d.ts`)
- **ioredis** >= 5 (opcional — solo si usas Redis)

<sub>Dependencias en runtime: solo `async-mutex` y `@msgpack/msgpack`</sub>

---

## Contribuir

Fixes, docs, performance, nuevos adaptadores — todo suma.

```bash
git clone https://github.com/flyingsquirrel0419/layercache
cd layercache
npm install
npm run lint && npm test && npm run build:all
```

Lee la [guía de contribución](../../CONTRIBUTING.md) y el [código de conducta](../../CODE_OF_CONDUCT.md).

---

## Licencia

[Apache 2.0](../../LICENSE) — úsalo libremente en lo que quieras.

---

<p align="center">
  Si layercache te ahorró tiempo, dale una <a href="https://github.com/flyingsquirrel0419/layercache">⭐ estrella en GitHub</a>. Ayuda a que más gente lo encuentre.
</p>
