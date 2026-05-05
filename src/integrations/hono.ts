import type { CacheStack } from '../CacheStack'
import type { CacheGetOptions } from '../types'
import { normalizeHttpCacheUrl } from './httpCacheKeys'

interface HonoLikeRequest {
  method?: string
  url?: string
  path?: string
  query?: Record<string, unknown>
  headers?: Headers | Record<string, unknown>
  header?: (name: string) => string | undefined
}

interface HonoLikeContext {
  req: HonoLikeRequest
  header?: (name: string, value: string) => void
  status?: (status: number) => unknown
  json: (body: unknown, status?: number) => Response | Promise<Response> | unknown
}

interface HonoCacheMiddlewareOptions extends CacheGetOptions {
  /**
   * Resolves a cache key from the incoming Hono request. Defaults to
   * `GET:<normalized path>` when `allowPrivateCaching` is enabled.
   */
  keyResolver?: (request: HonoLikeRequest) => string
  /** Only cache responses for these HTTP methods. Defaults to `['GET']`. */
  methods?: string[]
  /** Explicitly allow URL-only implicit cache keys. Disabled by default. */
  allowPrivateCaching?: boolean
}

/**
 * Hono-compatible middleware that caches JSON responses for selected methods.
 */
export function createHonoCacheMiddleware(cache: CacheStack, options: HonoCacheMiddlewareOptions = {}) {
  const allowedMethods = new Set((options.methods ?? ['GET']).map((method) => method.toUpperCase()))

  return async (context: HonoLikeContext, next: () => Promise<void>): Promise<unknown> => {
    const method = (context.req.method ?? 'GET').toUpperCase()
    if (!allowedMethods.has(method)) {
      await next()
      return
    }

    if (!options.keyResolver && options.allowPrivateCaching !== true) {
      await next()
      return
    }

    const rawPath = context.req.path ?? context.req.url ?? '/'
    const key = options.keyResolver ? options.keyResolver(context.req) : `${method}:${normalizeHttpCacheUrl(rawPath)}`

    const cached = await cache.get(key, undefined, options)
    if (cached !== null) {
      context.header?.('x-cache', 'HIT')
      context.header?.('content-type', 'application/json; charset=utf-8')
      return context.json(cached)
    }

    let currentStatus: number | undefined
    const originalStatus = context.status?.bind(context)
    if (originalStatus) {
      context.status = (status: number) => {
        currentStatus = status
        return originalStatus(status)
      }
    }

    const originalJson = context.json.bind(context)
    context.json = (body: unknown, status?: number) => {
      context.header?.('x-cache', 'MISS')
      if (isSuccessfulStatus(status ?? currentStatus)) {
        cache.set(key, body, options).catch((err: unknown) => {
          cache.emit('error', {
            operation: 'set',
            error: err instanceof Error ? err.message : String(err)
          })
        })
      }
      return originalJson(body, status)
    }

    await next()
  }
}

function isSuccessfulStatus(statusCode: number | undefined): boolean {
  return statusCode === undefined || (statusCode >= 200 && statusCode < 300)
}
