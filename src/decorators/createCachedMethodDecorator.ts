import type { CacheWrapOptions } from '../types'
import type { CacheStack } from '../CacheStack'

interface CachedMethodDecoratorOptions<TArgs extends unknown[]> extends CacheWrapOptions<TArgs> {
  cache: (instance: unknown) => CacheStack
  prefix?: string
}

export function createCachedMethodDecorator<TArgs extends unknown[] = unknown[]>(
  options: CachedMethodDecoratorOptions<TArgs>
): MethodDecorator {
  return ((_: object, propertyKey: string | symbol, descriptor: PropertyDescriptor) => {
    const original = descriptor.value as ((...args: unknown[]) => Promise<unknown>) | undefined
    if (typeof original !== 'function') {
      throw new Error('createCachedMethodDecorator can only be applied to methods.')
    }

    descriptor.value = async function (...args: unknown[]) {
      const cache = options.cache(this)
      const wrapped = cache.wrap(
        options.prefix ?? String(propertyKey),
        (...methodArgs: unknown[]) => Promise.resolve(original.apply(this, methodArgs)),
        options as CacheWrapOptions<unknown[]>
      )

      return wrapped(...args)
    }
  }) as MethodDecorator
}
