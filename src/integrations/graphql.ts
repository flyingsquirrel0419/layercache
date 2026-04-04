import type { CacheGetOptions } from '../types'
import type { CacheStack } from '../CacheStack'

interface GraphqlCacheOptions<TArgs extends unknown[]> extends CacheGetOptions {
  keyResolver?: (...args: TArgs) => string
}

export function cacheGraphqlResolver<TArgs extends unknown[], TResult>(
  cache: CacheStack,
  prefix: string,
  resolver: (...args: TArgs) => Promise<TResult>,
  options: GraphqlCacheOptions<TArgs> = {}
): (...args: TArgs) => Promise<TResult | null> {
  const wrapped = cache.wrap(prefix, resolver, {
    ...options,
    keyResolver: options.keyResolver
  })

  return (...args: TArgs) => wrapped(...args)
}
