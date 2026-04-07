import { describe, expect, it, vi } from 'vitest'
import { CacheStack } from '../../src/CacheStack'
import { createCacheStatsHandler } from '../../src/http/createCacheStatsHandler'
import { createExpressCacheMiddleware } from '../../src/integrations/express'
import { createFastifyLayercachePlugin } from '../../src/integrations/fastify'
import { cacheGraphqlResolver } from '../../src/integrations/graphql'
import { createHonoCacheMiddleware } from '../../src/integrations/hono'
import { createTrpcCacheMiddleware } from '../../src/integrations/trpc'
import { MemoryLayer } from '../../src/layers/MemoryLayer'

function makeCache() {
  return new CacheStack([new MemoryLayer({ ttl: 60 })])
}

// ---------------------------------------------------------------------------
// HTTP stats handler
// ---------------------------------------------------------------------------
describe('createCacheStatsHandler', () => {
  it('rejects public access by default', async () => {
    const cache = makeCache()
    const handler = createCacheStatsHandler(cache)

    const setHeader = vi.fn()
    const end = vi.fn()
    const response = { setHeader, end, statusCode: 0 }

    await handler({}, response)

    expect(response.statusCode).toBe(403)
    expect(end).toHaveBeenCalledWith(JSON.stringify({ error: 'Forbidden' }))
  })

  it('writes JSON stats when explicitly allowed', async () => {
    const cache = makeCache()
    const handler = createCacheStatsHandler(cache, { allowPublicAccess: true })

    const setHeader = vi.fn()
    const end = vi.fn()
    const response = { setHeader, end, statusCode: 0 }

    await handler({}, response)

    expect(response.statusCode).toBe(200)
    expect(setHeader).toHaveBeenCalledWith('content-type', expect.stringContaining('application/json'))
    const body = JSON.parse(end.mock.calls[0]?.[0] as string) as Record<string, unknown>
    expect(body).toHaveProperty('metrics')
    expect(body).toHaveProperty('layers')
  })
})

// ---------------------------------------------------------------------------
// Fastify plugin
// ---------------------------------------------------------------------------
describe('createFastifyLayercachePlugin', () => {
  it('decorates fastify with cache', async () => {
    const cache = makeCache()
    const plugin = createFastifyLayercachePlugin(cache, { exposeStatsRoute: false })
    const decorations: Record<string, unknown> = {}
    const fastify = {
      decorate: (name: string, value: unknown) => {
        decorations[name] = value
      },
      get: vi.fn()
    }

    await plugin(fastify)
    expect(decorations.cache).toBe(cache)
    expect(fastify.get).not.toHaveBeenCalled()
  })

  it('registers stats route when exposeStatsRoute is true', async () => {
    const cache = makeCache()
    const plugin = createFastifyLayercachePlugin(cache, {
      exposeStatsRoute: true,
      statsPath: '/stats',
      allowPublicStatsRoute: true
    })
    const registeredRoutes: string[] = []
    const fastify = {
      decorate: vi.fn(),
      get: (path: string) => {
        registeredRoutes.push(path)
      }
    }

    await plugin(fastify)
    expect(registeredRoutes).toContain('/stats')
  })

  it('does not both send and return the stats body when reply.send is available', async () => {
    const cache = makeCache()
    const plugin = createFastifyLayercachePlugin(cache, {
      exposeStatsRoute: true,
      allowPublicStatsRoute: true
    })

    let routeHandler:
      | ((
          request: unknown,
          reply: {
            header?: (name: string, value: string) => unknown
            send?: (body: unknown) => unknown
            statusCode?: number
          }
        ) => unknown | Promise<unknown>)
      | undefined

    await plugin({
      decorate: vi.fn(),
      get: (_path, handler) => {
        routeHandler = handler
      }
    })

    expect(routeHandler).toBeDefined()

    const reply = {
      header: vi.fn(),
      send: vi.fn(),
      statusCode: 0
    }

    const result = await routeHandler?.({}, reply)

    expect(reply.send).toHaveBeenCalledTimes(1)
    expect(result).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// GraphQL resolver wrapper
// ---------------------------------------------------------------------------
describe('cacheGraphqlResolver', () => {
  it('caches resolver results', async () => {
    const cache = makeCache()
    let calls = 0
    const resolver = async (_root: unknown, args: { id: number }) => {
      calls += 1
      return { id: args.id }
    }

    const cached = cacheGraphqlResolver(cache, 'user', resolver, {
      keyResolver: (_root, args) => String(args.id)
    })
    const result1 = await cached(null, { id: 1 })
    const result2 = await cached(null, { id: 1 })

    expect(result1).toEqual({ id: 1 })
    expect(result2).toEqual({ id: 1 })
    expect(calls).toBe(1)
  })

  it('uses custom keyResolver when provided', async () => {
    const cache = makeCache()
    let calls = 0
    const resolver = async (id: number) => {
      calls += 1
      return { id }
    }

    const cached = cacheGraphqlResolver(cache, 'user', resolver, {
      keyResolver: (id: number) => String(id)
    })

    await cached(1)
    await cached(1)
    expect(calls).toBe(1)
  })

  it('requires an explicit keyResolver by default', () => {
    const cache = makeCache()
    const resolver = async (_root: unknown, args: { id: number }) => ({ id: args.id })

    expect(() => cacheGraphqlResolver(cache, 'user', resolver)).toThrow(/requires a keyResolver/i)
  })
})

// ---------------------------------------------------------------------------
// tRPC middleware
// ---------------------------------------------------------------------------
describe('createTrpcCacheMiddleware', () => {
  it('caches procedure results', async () => {
    const cache = makeCache()
    const middleware = createTrpcCacheMiddleware(cache, 'proc', {
      ttl: 60,
      keyResolver: (input: { id: number }) => String(input.id)
    })

    let calls = 0
    const ctx = {
      path: 'getUser',
      type: 'query',
      rawInput: { id: 1 },
      next: async () => {
        calls += 1
        return { ok: true, data: { id: 1 } }
      }
    }

    const result1 = await middleware(ctx)
    const result2 = await middleware(ctx)

    expect(result1).toEqual({ ok: true, data: { id: 1 } })
    expect(result2).toEqual({ ok: true, data: { id: 1 } })
    expect(calls).toBe(1)
  })

  it('falls through to next() on cache miss', async () => {
    const cache = makeCache()
    const middleware = createTrpcCacheMiddleware(cache, 'fresh', {
      keyResolver: () => 'ping'
    })

    const ctx = {
      path: 'ping',
      rawInput: null,
      next: async () => ({ ok: true, data: 'pong' })
    }

    const result = await middleware(ctx)
    expect(result).toEqual({ ok: true, data: 'pong' })
  })

  it('requires an explicit keyResolver by default', () => {
    const cache = makeCache()
    expect(() => createTrpcCacheMiddleware(cache, 'proc')).toThrow(/requires a keyResolver/i)
  })
})

// ---------------------------------------------------------------------------
// Express middleware
// ---------------------------------------------------------------------------
describe('createExpressCacheMiddleware', () => {
  it('passes cache errors to next(error)', async () => {
    const cache = new CacheStack([new MemoryLayer({ ttl: 60 })])
    await cache.disconnect()

    const middleware = createExpressCacheMiddleware(cache, { allowPrivateCaching: true })
    const next = vi.fn()

    await middleware({ method: 'GET', url: '/users' }, {}, next)

    expect(next).toHaveBeenCalledTimes(1)
    expect(next.mock.calls[0]?.[0]).toBeInstanceOf(Error)
  })

  it('bypasses implicit URL-only caching by default', async () => {
    const cache = makeCache()
    const middleware = createExpressCacheMiddleware(cache)
    let calls = 0

    const run = async () => {
      const response = {
        setHeader: vi.fn(),
        json: vi.fn((body: unknown) => body)
      }

      await middleware(
        {
          method: 'GET',
          url: '/users'
        },
        response,
        () => {
          calls += 1
          response.json?.({ calls })
        }
      )
    }

    await run()
    await run()

    expect(calls).toBe(2)
  })

  it('supports implicit URL-only caching when explicitly allowed', async () => {
    const cache = makeCache()
    const middleware = createExpressCacheMiddleware(cache, { allowPrivateCaching: true })
    let calls = 0

    const run = async () => {
      const response = {
        setHeader: vi.fn(),
        json: vi.fn((body: unknown) => body)
      }

      await middleware(
        {
          method: 'GET',
          url: '/users'
        },
        response,
        () => {
          calls += 1
          response.json?.({ calls })
        }
      )
    }

    await run()
    await run()

    expect(calls).toBe(1)
  })
})

describe('createHonoCacheMiddleware', () => {
  it('surfaces cache errors to the framework as a rejected middleware promise', async () => {
    const cache = new CacheStack([new MemoryLayer({ ttl: 60 })])
    await cache.disconnect()

    const middleware = createHonoCacheMiddleware(cache, { allowPrivateCaching: true })

    await expect(
      middleware(
        {
          req: { method: 'GET', path: '/users' },
          json: (body) => body
        },
        async () => undefined
      )
    ).rejects.toThrow(/disconnecting/i)
  })

  it('bypasses implicit URL-only caching by default', async () => {
    const cache = makeCache()
    const middleware = createHonoCacheMiddleware(cache)
    let calls = 0

    const run = async () => {
      const context = {
        req: {
          method: 'GET',
          path: '/users'
        },
        header: vi.fn(),
        json: vi.fn((body) => body)
      }

      await middleware(context, async () => {
        calls += 1
        context.json({ calls })
      })
    }

    await run()
    await run()

    expect(calls).toBe(2)
  })

  it('returns the cached response object on hits', async () => {
    const cache = makeCache()
    const middleware = createHonoCacheMiddleware(cache, { allowPrivateCaching: true })
    const payload = { id: 1 }
    const expectedResponse = { ok: true, payload }

    let nextCalls = 0
    const firstContext = {
      req: { method: 'GET', path: '/users/1' },
      header: vi.fn(),
      json: vi.fn((body) => ({ ok: true, payload: body }))
    }

    await middleware(firstContext, async () => {
      nextCalls += 1
      firstContext.json(payload)
    })

    const secondContext = {
      req: { method: 'GET', path: '/users/1' },
      header: vi.fn(),
      json: vi.fn((body) => ({ ok: true, payload: body }))
    }

    const result = await middleware(secondContext, async () => {
      nextCalls += 1
    })

    expect(result).toEqual(expectedResponse)
    expect(nextCalls).toBe(1)
  })

  it('supports implicit URL-only caching when explicitly allowed', async () => {
    const cache = makeCache()
    const middleware = createHonoCacheMiddleware(cache, { allowPrivateCaching: true })
    let calls = 0

    const run = async () => {
      const context = {
        req: { method: 'GET', path: '/users' },
        header: vi.fn(),
        json: vi.fn((body) => body)
      }

      return middleware(context, async () => {
        calls += 1
        context.json({ calls })
      })
    }

    await run()
    await run()

    expect(calls).toBe(1)
  })
})
