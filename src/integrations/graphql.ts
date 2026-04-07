import type { CacheStack } from '../CacheStack'
import type { CacheGetOptions } from '../types'

interface GraphqlCacheOptions<TArgs extends unknown[]> extends CacheGetOptions {
  keyResolver?: (...args: TArgs) => string
  allowImplicitContextCaching?: boolean
}

export function cacheGraphqlResolver<TArgs extends unknown[], TResult>(
  cache: CacheStack,
  prefix: string,
  resolver: (...args: TArgs) => Promise<TResult>,
  options: GraphqlCacheOptions<TArgs> = {}
): (...args: TArgs) => Promise<TResult | null> {
  if (!options.keyResolver && options.allowImplicitContextCaching !== true) {
    throw new Error(
      'cacheGraphqlResolver requires a keyResolver or allowImplicitContextCaching=true because resolver output may depend on request context.'
    )
  }

  const wrapped = cache.wrap(prefix, resolver, {
    ...options,
    keyResolver: options.keyResolver
  })

  return (...args: TArgs) => wrapped(...args)
}
