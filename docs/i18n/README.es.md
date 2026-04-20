<p align="center">
  <a href="../../README.md">English</a> | <a href="./README.ko.md">한국어</a> | <a href="./README.zh-CN.md">简体中文</a> | <a href="./README.ja.md">日本語</a> | <strong>Español</strong>
</p>

<p align="center">
  <img src="../../logo.png" width="520" alt="layercache logo">
</p>

<h1 align="center">layercache</h1>

<p align="center">
  <strong>El toolkit de caché multicapa que Node.js merece.</strong><br>
  <em>Memoria + Redis + disco en un stack. Una API. Cero avalanchas.</em>
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

## El problema

Todo servicio Node.js en crecimiento choca con el mismo muro de caché:

```
Caché solo en memoria    --> Rápido, pero cada instancia ve datos distintos
Caché solo en Redis      --> Compartido, pero cada solicitud paga un viaje de red
Solución híbrida manual  --> Funciona... hasta que necesitas prevención de avalanchas,
                            invalidación, servicio de datos expirados,
                            observabilidad y consistencia distribuida
```

## La solución

**layercache** ofrece una caché multicapa unificada con funciones de nivel producción integradas:

```
              ┌───────────────────────────────────────┐
tu app  ---->│             layercache                │
              │                                       │
              │  L1 Memoria    ~0.01ms  (por proceso) │
              │      |                                │
              │  L2 Redis      ~0.5ms   (compartido)  │
              │      |                                │
              │  L3 Disco      ~2ms     (persistente) │
              │      |                                │
              │  Fetcher       ~20ms    (se ejecuta 1 vez) │
              └───────────────────────────────────────┘

En hit   --> sirve desde la capa más rápida, rellena las demás automáticamente
En miss  --> el fetcher se ejecuta UNA vez (incluso con 100x de concurrencia)
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
  new RedisLayer({ client: new Redis(), ttl: 3600 }),  // L2: compartido
])

// Lectura pasiva(read-through): el fetcher se ejecuta una vez, todas las capas se llenan
const user = await cache.get('user:123', () => db.findUser(123))
```

<details>
<summary><b>Solo memoria (no requiere Redis)</b></summary>

```ts
const cache = new CacheStack([
  new MemoryLayer({ ttl: 60 })
])
```

</details>

<details>
<summary><b>Configuración de tres capas con persistencia en disco</b></summary>

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

| Funcionalidad | Descripción |
|---|---|
| **Lecturas en capas + autorrelleno** | Lee primero desde L1; en un hit parcial, las capas superiores se rellenan automáticamente |
| **Prevención de avalanchas(stampede prevention)** | 100 solicitudes concurrentes para la misma clave = 1 ejecución del fetcher |
| **Single-flight distribuido** | Desduplicación entre instancias mediante locks de Redis con renovación de lease |
| **Operaciones en lote** | `getMany()` / `setMany()` / `mdelete()` con rutas rápidas a nivel de capa |
| **API `wrap()`** | Caché transparente de funciones con derivación automática de claves |
| **Namespaces** | Vistas de caché con alcance mediante soporte de prefijo jerárquico |
| **Calentamiento de caché** | Pre-llena las capas al inicio con carga basada en prioridad |
| **Caché negativo** | Almacena misses de caché (ej: "usuario no encontrado") con TTL corto |

### Invalidación y frescura

| Funcionalidad | Descripción |
|---|---|
| **Invalidación por tags** | Elimina todas las claves con un tag dado en todas las capas |
| **Invalidación por lotes de tags** | Operaciones multi-tag con semántica `any` / `all` |
| **Invalidación por comodín y prefijo** | Patrones de claves estilo glob y jerárquicos |
| **Rotación por generaciones** | Invalidación masiva de namespaces sin escaneo |
| **Stale-while-revalidate** | Retorna el valor en caché, refresca en segundo plano |
| **Stale-if-error** | Sigue sirviendo datos expirados cuando el upstream falla |
| **TTL deslizante(sliding TTL)** | Reinicia la expiración en cada lectura para claves frecuentes |
| **TTL adaptativo(adaptive TTL)** | Incrementa automáticamente el TTL de claves calientes hasta un límite |
| **Refresh-ahead** | Refresca proactivamente antes de la expiración |
| **Políticas de TTL** | Alinea las expiraciones a límites de calendario (`until-midnight`, `next-hour`, personalizado) |

### Resiliencia y operaciones

| Funcionalidad | Descripción |
|---|---|
| **Degradación graceful(graceful degradation)** | Omite temporalmente capas fallidas, mantiene la caché disponible |
| **Disyuntor(circuit breaker)** | Deja de atacar upstreams defectuosos tras fallos repetidos |
| **Limitación de tasa del fetcher** | Con alcance global, por clave, o por fetcher con buckets personalizados |
| **Políticas de escritura** | `strict` (falla si cualquier capa falla) o `best-effort` |
| **Write-behind** | Escrituras en lote con intervalo de flush configurable |
| **Compresión** | gzip / brotli en RedisLayer con umbral configurable |
| **MessagePack** | Serializadores intercambiables (JSON por defecto, MessagePack como alternativa) |
| **Persistencia** | Exporta/importa snapshots a memoria o disco |

### Observabilidad

| Funcionalidad | Descripción |
|---|---|
| **Métricas** | Hits, misses, fetches, hits expirados, disparos del disyuntor, y más |
| **Latencia por capa** | Promedio, máximo y conteo de muestras usando el algoritmo de Welford |
| **Health checks** | Endpoint asíncrono de salud por capa con medición de latencia |
| **Hooks de eventos** | `hit`, `miss`, `set`, `delete`, `stale-serve`, `stampede-dedupe`, `backfill`, `warm`, `error` |
| **OpenTelemetry** | Soporte de trazado distribuido basado en hooks sin monkey-patching de métodos |
| **Exportador Prometheus** | Exportación de métricas incluyendo gauges de latencia |
| **Handler HTTP de estadísticas** | Endpoint JSON para dashboards |
| **CLI de administración** | `npx layercache stats\|keys\|invalidate` para cachés respaldados por Redis |

---

## Integraciones

layercache se conecta con los frameworks que ya usas:

| Framework | Integración |
|---|---|
| **Express** | `createExpressCacheMiddleware(cache, opts)` - cachea respuestas automáticamente con header `x-cache: HIT/MISS` |
| **Fastify** | `createFastifyLayercachePlugin(cache, opts)` - registra `fastify.cache` con ruta de estadísticas opcional |
| **Hono** | `createHonoCacheMiddleware(cache, opts)` - middleware compatible con edge |
| **tRPC** | `createTrpcCacheMiddleware(cache, prefix, opts)` - middleware de procedimiento |
| **GraphQL** | `cacheGraphqlResolver(cache, prefix, resolver, opts)` - wrapper de resolver de campo |
| **Next.js** | Funciona nativamente con App Router y API routes |
| **OpenTelemetry** | `createOpenTelemetryPlugin(cache, tracer)` - spans de trazado basados en eventos sin monkey-patching |

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

layercache está diseñado para entornos de producción con múltiples instancias:

```
  ┌───────────┐    ┌───────────┐    ┌───────────┐
  │ Servidor A│    │ Servidor B│    │ Servidor C│
  │ [Memory]  │    │ [Memory]  │    │ [Memory]  │
  └─────┬─────┘    └─────┬─────┘    └─────┬─────┘
        │                │                │
        └──── Redis Pub/Sub ──────────────┘  <-- Bus de invalidación L1
                     │
               ┌─────┴──────┐
               │   Redis    │  <-- L2 compartido + índice de tags + single-flight
               └────────────┘
```

- **Single-flight con Redis** - desduplicación de misses entre instancias con locks distribuidos
- **Bus de invalidación Redis** - invalidación L1 basada en Pub/Sub para consistencia de memoria
- **Índice de tags Redis** - seguimiento de tags compartido con sharding opcional
- **Persistencia de snapshots** - exporta/importa estado entre instancias

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
┌─────────────────────┬──────────────┐
│ Escenario           │ Latencia promedio │
├─────────────────────┼──────────────┤
│ Hit L1 memoria      │   ~0.006 ms  │
│ Hit L2 Redis        │   ~0.020 ms  │
│ Sin caché (sim. DB) │   ~1.08  ms  │
└─────────────────────┴──────────────┘

┌─────────────────────┬────────┐
│ Solicitudes concurrentes │  100   │
│ Ejecuciones del fetcher  │    1   │  <-- prevención de avalanchas
└─────────────────────┴────────┘
```

Los comand de benchmark, fixtures y notas de escenarios están en [documentación de benchmarks](../benchmarking.md).

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
| Disyuntor | -- | -- | -- | **Yes** |
| Degradación graceful | -- | -- | -- | **Yes** |
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

> Ver la [guía de comparación](../comparison.md) para un desglose detallado.

---

## Documentación

| Documento | Descripción |
|---|---|
| [Referencia API](../api.md) | Documentación completa de la API con todas las opciones |
| [Tutorial](../tutorial.md) | Walkthrough operativo paso a paso |
| [Guía de comparación](../comparison.md) | Comparación detallada de funcionalidades con alternativas |
| [Guía de migración](../migration-guide.md) | Migrar desde node-cache-manager, keyv o cacheable |
| [Benchmarks](../benchmarking.md) | Escenarios de benchmark y metodología |
| [Changelog](../../CHANGELOG.md) | Historial de versiones y cambios disruptivos |

---

## Ejemplos

El directorio [`examples/`](../../examples) contiene proyectos listos para ejecutar:

- [`express-api/`](../../examples/express-api/) - API REST con Express y caché en capas
- [`nextjs-api-routes/`](../../examples/nextjs-api-routes/) - Next.js App Router con layercache

---

## Requisitos

- **Node.js** >= 20
- **TypeScript** >= 5.0 (opcional - totalmente tipado, incluye `.d.ts`)
- **ioredis** >= 5 (opcional - solo necesario para funcionalidad Redis)

<sub>Dependencias en runtime: `async-mutex` y `@msgpack/msgpack`</sub>

---

## Contribuir

Las contribuciones son bienvenidas - correcciones de bugs, documentación, rendimiento, nuevos adaptadores, o issues.

```bash
git clone https://github.com/flyingsquirrel0419/layercache
cd layercache
npm install
npm run lint && npm test && npm run build:all
```

Consulta la [guía de contribución](../../CONTRIBUTING.md) y el [código de conducta](../../CODE_OF_CONDUCT.md).

---

## Licencia

[Apache 2.0](../../LICENSE) - uso libre en proyectos personales y comerciales.

---

<p align="center">
  Si layercache te ahorra tiempo, considera darle una <a href="https://github.com/flyingsquirrel0419/layercache">estrella en GitHub</a>. Ayuda a otros a descubrir el proyecto.
</p>
