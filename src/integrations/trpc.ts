import type { CacheStack } from '../CacheStack'
import type { CacheGetOptions } from '../types'

interface TrpcCacheMiddlewareContext<TInput = unknown, TResult = unknown, TContext = unknown> {
  /** Procedure path, when supplied by the adapter. */
  path?: string
  /** Procedure type, such as query or mutation. */
  type?: string
  /** Parsed procedure input supplied by current tRPC middleware contracts. */
  input?: TInput
  /** Legacy raw procedure input used by older adapters. */
  rawInput?: TInput
  /** Raw input accessor supplied by current tRPC middleware contracts. */
  getRawInput?: () => Promise<unknown>
  /** Authenticated procedure context, when supplied by the adapter. */
  ctx?: TContext
  /** Runs the next tRPC middleware or resolver. */
  next: () => Promise<{ ok: boolean; data?: TResult }>
}

interface TrpcCacheMiddlewareOptions<TInput, TContext> extends CacheGetOptions {
  /** Converts procedure input and metadata into a stable cache key suffix. */
  keyResolver?: (input: TInput, path?: string, type?: string, context?: TContext) => string
  /** Allow fallback key generation from procedure path and raw input. */
  allowImplicitContextCaching?: boolean
}

/**
 * Creates a tRPC middleware that caches successful procedure results.
 */
export function createTrpcCacheMiddleware<TInput = unknown, TResult = unknown, TContext = unknown>(
  cache: CacheStack,
  prefix: string,
  options: TrpcCacheMiddlewareOptions<TInput, TContext> = {}
) {
  if (!options.keyResolver && options.allowImplicitContextCaching !== true) {
    throw new Error(
      'createTrpcCacheMiddleware requires a keyResolver or allowImplicitContextCaching=true because procedure output may depend on request context.'
    )
  }

  return async (context: TrpcCacheMiddlewareContext<TInput, TResult, TContext>) => {
    const input = await resolveTrpcInput(context)
    const key = options.keyResolver
      ? `${prefix}:${options.keyResolver(input, context.path, context.type, context.ctx)}`
      : `${prefix}:${context.path ?? 'procedure'}:${JSON.stringify(input ?? null)}`

    const callerShouldCache = options.shouldCache
    const cacheOptions: CacheGetOptions = {
      ...options,
      shouldCache: (result) => {
        if (!isSuccessfulTrpcResult(result)) {
          return false
        }
        return callerShouldCache ? callerShouldCache(result) : true
      }
    }

    let didFetch = false
    let fetchedResult: { ok: boolean; data?: TResult } | null = null
    const cached = await cache.get<{ ok: boolean; data?: TResult }>(
      key,
      async () => {
        didFetch = true
        fetchedResult = await context.next()
        return fetchedResult
      },
      cacheOptions
    )

    if (cached !== undefined) {
      return cached
    }

    if (didFetch) {
      return fetchedResult
    }

    return context.next()
  }
}

async function resolveTrpcInput<TInput, TResult, TContext>(
  context: TrpcCacheMiddlewareContext<TInput, TResult, TContext>
): Promise<TInput> {
  if (Object.prototype.hasOwnProperty.call(context, 'input')) {
    return context.input as TInput
  }
  if (context.getRawInput) {
    return (await context.getRawInput()) as TInput
  }
  return context.rawInput as TInput
}

function isSuccessfulTrpcResult(value: unknown): value is { ok: true; data?: unknown } {
  return Boolean(value && typeof value === 'object' && (value as { ok?: unknown }).ok === true)
}
