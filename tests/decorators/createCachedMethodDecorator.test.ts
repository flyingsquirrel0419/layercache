import { describe, expect, it, vi } from 'vitest'
import { CacheStack } from '../../src/CacheStack'
import { createCachedMethodDecorator } from '../../src/decorators/createCachedMethodDecorator'
import { MemoryLayer } from '../../src/layers/MemoryLayer'

describe('createCachedMethodDecorator', () => {
  it('creates one wrapped function per instance', async () => {
    const cache = new CacheStack([new MemoryLayer({ ttl: 60 })])
    let calls = 0

    class Service {
      async load(id: number) {
        calls += 1
        return { id }
      }
    }

    const descriptor = Object.getOwnPropertyDescriptor(Service.prototype, 'load')
    if (!descriptor) {
      throw new Error('Missing descriptor')
    }

    createCachedMethodDecorator({
      cache: () => cache,
      prefix: 'service'
    })(Service.prototype, 'load', descriptor)
    Object.defineProperty(Service.prototype, 'load', descriptor)

    const service = new Service()
    await expect(service.load(1)).resolves.toEqual({ id: 1 })
    await expect(service.load(1)).resolves.toEqual({ id: 1 })
    expect(calls).toBe(1)
  })

  it('falls back to the method name when no prefix is provided', async () => {
    const wrap = vi.fn((_: string, fetcher: (...args: unknown[]) => Promise<unknown>) => {
      return async (...args: unknown[]) => fetcher(...args)
    })
    const cache = { wrap } as unknown as CacheStack

    class Service {
      async load(id: number) {
        return { id }
      }
    }

    const descriptor = Object.getOwnPropertyDescriptor(Service.prototype, 'load')
    if (!descriptor) {
      throw new Error('Missing descriptor')
    }

    createCachedMethodDecorator({
      cache: () => cache
    })(Service.prototype, 'load', descriptor)
    Object.defineProperty(Service.prototype, 'load', descriptor)

    const service = new Service()
    await expect(service.load(2)).resolves.toEqual({ id: 2 })
    expect(wrap).toHaveBeenCalledWith('load', expect.any(Function), expect.any(Object))
  })

  it('throws when applied to a non-method descriptor', () => {
    const cache = new CacheStack([new MemoryLayer({ ttl: 60 })])
    const descriptor = { value: 123 } as unknown as PropertyDescriptor

    expect(() =>
      createCachedMethodDecorator({
        cache: () => cache,
        prefix: 'service'
      })({}, 'field', descriptor)
    ).toThrow(/only be applied to methods/i)
  })
})
