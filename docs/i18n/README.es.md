<p align="center">
  <a href="../../README.md">English</a> | <a href="./README.ko.md">한국어</a> | <a href="./README.zh-CN.md">简体中文</a> | <a href="./README.ja.md">日本語</a> | <strong>Español</strong>
</p>

<p align="center">
  <img src="../../logo.png" width="520" alt="layercache logo">
</p>

<h1 align="center">layercache</h1>

<p align="center">
  <strong>El toolkit de caché multicapa que Node.js merece.</strong><br>
  <em>Memoria + Redis + disco en un solo stack. Una API. Cero avalanchas.</em>
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
  <a href="https://layercache.flyingsquirrel.me">Sitio web</a>&nbsp;&nbsp;|&nbsp;&nbsp;
  <a href="#-inicio-rápido">Inicio rápido</a>&nbsp;&nbsp;|&nbsp;&nbsp;
  <a href="#-funcionalidades">Funcionalidades</a>&nbsp;&nbsp;|&nbsp;&nbsp;
  <a href="../api.md">Referencia API</a>&nbsp;&nbsp;|&nbsp;&nbsp;
  <a href="#-integraciones">Integraciones</a>&nbsp;&nbsp;|&nbsp;&nbsp;
  <a href="#-comparación">Comparación</a>&nbsp;&nbsp;|&nbsp;&nbsp;
  <a href="../tutorial.md">Tutorial</a>&nbsp;&nbsp;|&nbsp;&nbsp;
  <a href="../migration-guide.md">Guía de migración</a>
</p>

---

## El problema que todos conocen

Todo servicio Node.js que crece se choca con el mismo muro:

```
Solo memoria          --> Rápido, pero cada instancia ve datos distintos
Solo Redis            --> Compartido, sí, pero cada request paga un round-trip
Solución casera       --> Funciona... hasta que necesitas prevenir avalanchas,
                          invalidar por tags, servir datos expirados cuando
                          el origen falla, tener observabilidad y consistencia
                          distribuida. Ahí se complica.
```

## La propuesta de layercache

**layercache** te da una caché multicapa unificada, lista para producción:

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

Hit    --> devuelve de la capa más rápida y rellena las demás
Miss   --> el fetcher se ejecuta UNA vez (incluso con 100x concurrencia)
```

---

## Inicio rápido

```bash
npm install layercache
```

```ts
import { CacheStack, MemoryLayer, RedisLayer } from 'layercache'
import Redis from 'ioredis'

const cache = new CacheStack([
  new MemoryLayer({ ttl: 60, maxSize: 1_000 }),       // L1: en proceso
  new RedisLayer({ client: new Redis(), ttl: 3600 }),  // L2: Redis
])

// Lee y rellena automáticamente (read-through)
const user = await cache.get('user:123', () => db.findUser(123))
```

<details>
<summary><b>Solo memoria (sin Redis)</b></summary>

```ts
const cache = new CacheStack([
  new MemoryLayer({ ttl: 60 })
])
```

</details>

<details>
<summary><b>Tres capas con persistencia en disco</b></summary>

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

## Funcionalidades

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
| **Rotación por generaciones** | Cambia toda una generación de namespace sin escanear nada |
| **Stale-while-revalidate** | Devuelve lo cacheado y refresca de fondo |
| **Stale-if-error** | Si el origen falla, sigue sirviendo lo expirado sin pestañear |
| **TTL deslizante** | Cada lectura renueva la expiración de las claves populares |
| **TTL adaptativo** | Las claves calientes ven su TTL crecer automáticamente |
| **Refresh-ahead** | Refresca antes de que expire, sin que nadie lo pida |
| **Políticas de TTL** | Alinea expiraciones a medianoche, a la hora en punto, o como quieras |

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
| **Hooks de eventos** | `hit`, `miss`, `set`, `delete`, `stale-serve`, `stampede-dedupe`, `backfill`, `warm`, `error` |
| **OpenTelemetry** | Trazado distribuido vía hooks, sin tocar el código fuente |
| **Exportador Prometheus** | Métricas listas para scrape, incluyendo gauges de latencia |
| **Handler HTTP de stats** | Endpoint JSON para dashboards |
| **CLI de administración** | `npx layercache stats\|keys\|invalidate` |

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

## Rendimiento

```
┌─────────────────────────┬──────────────┐
│ Scenario                │ Avg Latency  │
├─────────────────────────┼──────────────┤
│ L1 memory hit           │   ~0.006 ms  │
│ L2 Redis hit            │   ~0.020 ms  │
│ No cache (simulated DB) │   ~1.08  ms  │
└─────────────────────────┴──────────────┘

┌───────────────────────────┬────────┐
│ Concurrent requests        │  100   │
│ Fetcher executions         │    1   │  <-- stampede prevention
└───────────────────────────┴────────┘
```

Los comandos de benchmark, fixtures y escenarios están en la [doc de benchmarks](../benchmarking.md).

---

## Comparación

|  | node-cache-manager | keyv | cacheable | **layercache** |
|---|:---:|:---:|:---:|:---:|
| Multicapa con autorrelleno | Parcial | Plugin | -- | **Yes** |
| Prevención de avalanchas | -- | -- | -- | **Yes** |
| Single-flight distribuido | -- | -- | -- | **Yes** |
| Invalidación por tags | -- | -- | Yes | **Yes** |
| Tags distribuidos | -- | -- | -- | **Yes** |
| Flush L1 entre servidores | -- | -- | -- | **Yes** |
| Stale-while-revalidate | -- | -- | -- | **Yes** |
| Circuit breaker | -- | -- | -- | **Yes** |
| Degradación elegante | -- | -- | -- | **Yes** |
| TTL deslizante / adaptativo | -- | -- | -- | **Yes** |
| Calentamiento de caché | -- | -- | -- | **Yes** |
| Persistencia / snapshots | -- | -- | -- | **Yes** |
| Compresión | -- | -- | Yes | **Yes** |
| CLI de administración | -- | -- | -- | **Yes** |
| TypeScript-first | Parcial | Yes | Yes | **Yes** |
| API Wrap / decorador | Yes | -- | -- | **Yes** |
| Namespaces | -- | Yes | Yes | **Yes** |
| Hooks de eventos | Yes | Yes | Yes | **Yes** |
| Capas personalizadas | Parcial | -- | -- | **Yes** |

> Para un desglose detallado, consulta la [guía de comparación](../comparison.md).

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
