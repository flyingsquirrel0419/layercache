import type { CacheStack } from '../CacheStack'
import type { CacheWrapOptions } from '../types'

interface CachedMethodDecoratorOptions<TArgs extends unknown[]> extends CacheWrapOptions<TArgs> {
  cache: (instance: unknown) => CacheStack
  prefix?: string
}

export function createCachedMethodDecorator<TArgs extends unknown[] = unknown[]>(
  options: CachedMethodDecoratorOptions<TArgs>
): MethodDecorator {
  const wrappedByInstance = new WeakMap<object, (...args: unknown[]) => Promise<unknown | null>>()

  return ((_: object, propertyKey: string | symbol, descriptor: PropertyDescriptor) => {
    const original = descriptor.value as ((...args: unknown[]) => Promise<unknown>) | undefined
    if (typeof original !== 'function') {
      throw new Error('createCachedMethodDecorator can only be applied to methods.')
    }

    descriptor.value = async function (...args: unknown[]) {
      const instance = this as object
      let wrapped = wrappedByInstance.get(instance)
      if (!wrapped) {
        const cache = options.cache(instance)
        wrapped = cache.wrap(
          options.prefix ?? String(propertyKey),
          (...methodArgs: unknown[]) => Promise.resolve(original.apply(instance, methodArgs)),
          options as CacheWrapOptions<unknown[]>
        )
        wrappedByInstance.set(instance, wrapped)
      }

      return wrapped(...args)
    }
  }) as MethodDecorator
}
