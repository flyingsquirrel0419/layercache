import type { CacheStack } from '../../../src/CacheStack'
import { createCachedMethodDecorator } from '../../../src/decorators/createCachedMethodDecorator'
import type { CacheWrapOptions } from '../../../src/types'

interface CacheableOptions<TArgs extends unknown[]> extends CacheWrapOptions<TArgs> {
  cache: (instance: unknown) => CacheStack
  prefix?: string
}

export function Cacheable<TArgs extends unknown[] = unknown[]>(options: CacheableOptions<TArgs>): MethodDecorator {
  return createCachedMethodDecorator(options)
}
