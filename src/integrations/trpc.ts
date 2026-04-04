import type { CacheGetOptions } from '../types'
import type { CacheStack } from '../CacheStack'

interface TrpcCacheMiddlewareContext<TInput = unknown, TResult = unknown> {
  path?: string
  type?: string
  rawInput?: TInput
  next: () => Promise<{ ok: boolean; data?: TResult }>
}

interface TrpcCacheMiddlewareOptions<TInput> extends CacheGetOptions {
  keyResolver?: (input: TInput, path?: string, type?: string) => string
}

export function createTrpcCacheMiddleware<TInput = unknown, TResult = unknown>(
  cache: CacheStack,
  prefix: string,
  options: TrpcCacheMiddlewareOptions<TInput> = {}
) {
  return async (context: TrpcCacheMiddlewareContext<TInput, TResult>) => {
    const key = options.keyResolver
      ? `${prefix}:${options.keyResolver(context.rawInput as TInput, context.path, context.type)}`
      : `${prefix}:${context.path ?? 'procedure'}:${JSON.stringify(context.rawInput ?? null)}`

    let didFetch = false
    let fetchedResult: { ok: boolean; data?: TResult } | null = null
    const cached = await cache.get<{ ok: boolean; data?: TResult }>(
      key,
      async () => {
        didFetch = true
        fetchedResult = await context.next()
        return fetchedResult
      },
      options
    )

    if (cached !== null) {
      return cached
    }

    if (didFetch) {
      return fetchedResult
    }

    return context.next()
  }
}
