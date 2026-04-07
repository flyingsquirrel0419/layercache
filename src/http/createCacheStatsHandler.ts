import type { CacheStack } from '../CacheStack'

interface CacheStatsHandlerOptions {
  allowPublicAccess?: boolean
  authorize?: (request: unknown) => boolean | Promise<boolean>
  unauthorizedStatusCode?: number
}

export function createCacheStatsHandler(cache: CacheStack, options: CacheStatsHandlerOptions = {}) {
  return async (
    request: unknown,
    response: {
      setHeader?: (name: string, value: string) => void
      end: (body: string) => void
      statusCode?: number
    }
  ): Promise<void> => {
    response.setHeader?.('content-type', 'application/json; charset=utf-8')
    response.setHeader?.('cache-control', 'no-store')
    response.setHeader?.('x-content-type-options', 'nosniff')

    const isAuthorized =
      options.allowPublicAccess === true || (options.authorize ? await options.authorize(request) : false)

    if (!isAuthorized) {
      response.statusCode = options.unauthorizedStatusCode ?? 403
      response.end(JSON.stringify({ error: 'Forbidden' }))
      return
    }

    response.statusCode = 200
    response.end(JSON.stringify(cache.getStats(), null, 2))
  }
}
