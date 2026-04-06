import type { CacheStack } from '../CacheStack'
import type { CacheGetOptions } from '../types'

interface HonoLikeRequest {
  method?: string
  url?: string
  path?: string
  query?: Record<string, unknown>
}

interface HonoLikeContext {
  req: HonoLikeRequest
  header?: (name: string, value: string) => void
  json: (body: unknown, status?: number) => Response | Promise<Response> | unknown
}

interface HonoCacheMiddlewareOptions extends CacheGetOptions {
  keyResolver?: (request: HonoLikeRequest) => string
  methods?: string[]
}

export function createHonoCacheMiddleware(cache: CacheStack, options: HonoCacheMiddlewareOptions = {}) {
  const allowedMethods = new Set((options.methods ?? ['GET']).map((method) => method.toUpperCase()))

  return async (context: HonoLikeContext, next: () => Promise<void>): Promise<void> => {
    const method = (context.req.method ?? 'GET').toUpperCase()
    if (!allowedMethods.has(method)) {
      await next()
      return
    }

    const rawPath = context.req.path ?? context.req.url ?? '/'
    const key = options.keyResolver ? options.keyResolver(context.req) : `${method}:${normalizeUrl(rawPath)}`

    const cached = await cache.get(key, undefined, options)
    if (cached !== null) {
      context.header?.('x-cache', 'HIT')
      context.header?.('content-type', 'application/json; charset=utf-8')
      context.json(cached)
      return
    }

    const originalJson = context.json.bind(context)
    context.json = (body: unknown, status?: number) => {
      context.header?.('x-cache', 'MISS')
      cache.set(key, body, options).catch((err: unknown) => {
        cache.emit('error', {
          operation: 'set',
          error: err instanceof Error ? err.message : String(err)
        })
      })
      return originalJson(body, status)
    }

    await next()
  }
}

function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url, 'http://localhost')
    parsed.searchParams.sort()
    return decodeURIComponent(parsed.pathname) + parsed.search
  } catch {
    return url
  }
}
