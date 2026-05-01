import type { CacheStack } from '../CacheStack'
import type { CacheGetOptions } from '../types'

interface ExpressLikeRequest {
  method?: string
  url?: string
  originalUrl?: string
  path?: string
  query?: Record<string, unknown>
  headers?: Headers | Record<string, unknown>
  get?: (name: string) => string | undefined | null
}

interface ExpressLikeResponse {
  statusCode?: number
  setHeader?: (name: string, value: string) => void
  json?: (body: unknown) => void
  end?: (body?: string) => void
}

type NextFunction = (error?: unknown) => void

interface ExpressCacheMiddlewareOptions extends CacheGetOptions {
  /**
   * Resolves a cache key from the incoming request. Defaults to
   * `GET:<req.originalUrl || req.url>`.
   */
  keyResolver?: (req: ExpressLikeRequest) => string
  /**
   * Only cache responses for these HTTP methods. Defaults to `['GET']`.
   */
  methods?: string[]
  /** Explicitly allow URL-only implicit cache keys. Disabled by default. */
  allowPrivateCaching?: boolean
}

/**
 * Express/Connect-compatible middleware that caches JSON responses.
 *
 * ```ts
 * import express from 'express'
 * import { CacheStack, MemoryLayer, createExpressCacheMiddleware } from 'layercache'
 *
 * const cache = new CacheStack([new MemoryLayer({ ttl: 60_000 })])
 * const app = express()
 *
 * app.get('/api/data', createExpressCacheMiddleware(cache, { ttl: 30_000 }), (req, res) => {
 *   res.json({ fresh: true })
 * })
 * ```
 */
export function createExpressCacheMiddleware(cache: CacheStack, options: ExpressCacheMiddlewareOptions = {}) {
  const allowedMethods = new Set((options.methods ?? ['GET']).map((m) => m.toUpperCase()))

  return async (req: ExpressLikeRequest, res: ExpressLikeResponse, next: NextFunction): Promise<void> => {
    try {
      const method = (req.method ?? 'GET').toUpperCase()
      if (!allowedMethods.has(method)) {
        next()
        return
      }

      if (!options.keyResolver && options.allowPrivateCaching !== true) {
        next()
        return
      }

      const rawUrl = req.originalUrl ?? req.url ?? '/'
      const key = options.keyResolver ? options.keyResolver(req) : `${method}:${normalizeUrl(rawUrl)}`

      const cached = await cache.get<unknown>(key, undefined, options)
      if (cached !== null) {
        res.setHeader?.('content-type', 'application/json; charset=utf-8')
        res.setHeader?.('x-cache', 'HIT')
        if (res.json) {
          res.json(cached)
        } else {
          res.end?.(JSON.stringify(cached))
        }
        return
      }

      // Intercept res.json to capture the response body for caching
      const originalJson = res.json?.bind(res)
      if (originalJson) {
        res.json = (body: unknown) => {
          res.setHeader?.('x-cache', 'MISS')
          // Fire and forget — don't delay the response
          cache.set(key, body, options).catch((err: unknown) => {
            cache.emit('error', {
              operation: 'set',
              error: err instanceof Error ? err.message : String(err)
            })
          })
          return originalJson(body)
        }
      }

      next()
    } catch (error) {
      next(error)
    }
  }
}

function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url, 'http://localhost')
    parsed.searchParams.sort()
    return parsed.pathname + parsed.search
  } catch {
    return url
  }
}
