import { describe, expect, it } from 'vitest'
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
})
