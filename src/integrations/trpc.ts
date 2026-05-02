import type { CacheStack } from '../CacheStack'
import type { CacheGetOptions } from '../types'

interface TrpcCacheMiddlewareContext<TInput = unknown, TResult = unknown> {
  /** Procedure path, when supplied by the adapter. */
  path?: string
  /** Procedure type, such as query or mutation. */
  type?: string
  /** Raw procedure input used by the key resolver. */
  rawInput?: TInput
  /** Runs the next tRPC middleware or resolver. */
  next: () => Promise<{ ok: boolean; data?: TResult }>
}

interface TrpcCacheMiddlewareOptions<TInput> extends CacheGetOptions {
  /** Converts procedure input and metadata into a stable cache key suffix. */
  keyResolver?: (input: TInput, path?: string, type?: string) => string
  /** Allow fallback key generation from procedure path and raw input. */
  allowImplicitContextCaching?: boolean
}

/**
 * Creates a tRPC middleware that caches successful procedure results.
 */
export function createTrpcCacheMiddleware<TInput = unknown, TResult = unknown>(
  cache: CacheStack,
  prefix: string,
  options: TrpcCacheMiddlewareOptions<TInput> = {}
) {
  if (!options.keyResolver && options.allowImplicitContextCaching !== true) {
    throw new Error(
      'createTrpcCacheMiddleware requires a keyResolver or allowImplicitContextCaching=true because procedure output may depend on request context.'
    )
  }

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
