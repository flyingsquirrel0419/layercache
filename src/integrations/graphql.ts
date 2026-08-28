import type { CacheStack } from '../CacheStack'
import type { CacheGetOptions } from '../types'

interface GraphqlCacheOptions<TArgs extends unknown[]> extends CacheGetOptions {
  /** Converts resolver arguments into a stable cache key suffix. */
  keyResolver: (...args: TArgs) => string
}

/**
 * Wraps a GraphQL resolver with read-through caching. The key resolver must
 * include every argument and request-context attribute that affects output.
 */
export function cacheGraphqlResolver<TArgs extends unknown[], TResult>(
  cache: CacheStack,
  prefix: string,
  resolver: (...args: TArgs) => Promise<TResult>,
  options: GraphqlCacheOptions<TArgs> = {} as GraphqlCacheOptions<TArgs>
): (...args: TArgs) => Promise<TResult | undefined> {
  if (!options.keyResolver) {
    throw new Error(
      'cacheGraphqlResolver requires a keyResolver that includes every resolver argument and request-context attribute affecting output.'
    )
  }

  const wrapped = cache.wrap(prefix, resolver, {
    ...options,
    keyResolver: options.keyResolver
  })

  return (...args: TArgs) => wrapped(...args)
}
