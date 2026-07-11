import { describe, expect, it, vi } from 'vitest'
import { CacheStack } from '../../src/CacheStack'
import { createCachedMethodDecorator } from '../../src/decorators/createCachedMethodDecorator'
import { MemoryLayer } from '../../src/layers/MemoryLayer'

describe('createCachedMethodDecorator', () => {
  it('creates one wrapped function per instance', async () => {
    const cache = new CacheStack([new MemoryLayer({ ttl: 60_000 })])
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

  it('does not share cached method results between instances using the same cache', async () => {
    const cache = new CacheStack([new MemoryLayer({ ttl: 60_000 })])
    let calls = 0

    class Service {
      constructor(private readonly tenant: string) {}

      async load(id: number) {
        calls += 1
        return { id, tenant: this.tenant }
      }
    }

    const descriptor = Object.getOwnPropertyDescriptor(Service.prototype, 'load')
    if (!descriptor) throw new Error('Missing descriptor')
    createCachedMethodDecorator({ cache: () => cache, prefix: 'service' })(Service.prototype, 'load', descriptor)
    Object.defineProperty(Service.prototype, 'load', descriptor)

    await expect(new Service('alpha').load(1)).resolves.toEqual({ id: 1, tenant: 'alpha' })
    await expect(new Service('beta').load(1)).resolves.toEqual({ id: 1, tenant: 'beta' })
    expect(calls).toBe(2)
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
    expect(wrap).toHaveBeenCalledWith(
      expect.stringMatching(/^load:instance:/),
      expect.any(Function),
      expect.any(Object)
    )
  })

  it('throws when applied to a non-method descriptor', () => {
    const cache = new CacheStack([new MemoryLayer({ ttl: 60_000 })])
    const descriptor = { value: 123 } as unknown as PropertyDescriptor

    expect(() =>
      createCachedMethodDecorator({
        cache: () => cache,
        prefix: 'service'
      })({}, 'field', descriptor)
    ).toThrow(/only be applied to methods/i)
  })
})
