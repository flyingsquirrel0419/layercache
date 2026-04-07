import type { CacheStack } from '../CacheStack'

export function createCacheStatsHandler(cache: CacheStack) {
  return async (
    _request: unknown,
    response: {
      setHeader?: (name: string, value: string) => void
      end: (body: string) => void
      statusCode?: number
    }
  ): Promise<void> => {
    response.statusCode = 200
    response.setHeader?.('content-type', 'application/json; charset=utf-8')
    response.setHeader?.('cache-control', 'no-store')
    response.setHeader?.('x-content-type-options', 'nosniff')
    response.end(JSON.stringify(cache.getStats(), null, 2))
  }
}
