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
  return new CacheStack([new MemoryLayer({ ttl: 60_000 })])
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

  it('supports async authorization and custom unauthorized status codes', async () => {
    const cache = makeCache()
    const handler = createCacheStatsHandler(cache, {
      authorize: async (request) => request === 'allowed',
      unauthorizedStatusCode: 401
    })

    const unauthorized = { setHeader: vi.fn(), end: vi.fn(), statusCode: 0 }
    await handler('denied', unauthorized)
    expect(unauthorized.statusCode).toBe(401)

    const authorized = { setHeader: vi.fn(), end: vi.fn(), statusCode: 0 }
    await handler('allowed', authorized)
    expect(authorized.statusCode).toBe(200)
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

  it('returns a body directly when reply.send is unavailable and enforces authorization', async () => {
    const cache = makeCache()
    const plugin = createFastifyLayercachePlugin(cache, {
      exposeStatsRoute: true,
      authorizeStatsRoute: async () => false,
      unauthorizedStatusCode: 401
    })

    let routeHandler:
      | ((
          request: unknown,
          reply: { header?: (name: string, value: string) => unknown; statusCode?: number }
        ) => unknown | Promise<unknown>)
      | undefined

    await plugin({
      decorate: vi.fn(),
      get: (_path, handler) => {
        routeHandler = handler
      }
    })

    const reply = {
      header: vi.fn(),
      statusCode: 0
    }

    const result = await routeHandler?.({}, reply)
    expect(reply.statusCode).toBe(401)
    expect(result).toEqual({ error: 'Forbidden' })
  })

  it('returns stats bodies directly when reply.send is unavailable', async () => {
    const cache = makeCache()
    const plugin = createFastifyLayercachePlugin(cache, {
      exposeStatsRoute: true,
      allowPublicStatsRoute: true
    })

    let routeHandler:
      | ((
          request: unknown,
          reply: { header?: (name: string, value: string) => unknown; statusCode?: number }
        ) => unknown | Promise<unknown>)
      | undefined

    await plugin({
      decorate: vi.fn(),
      get: (_path, handler) => {
        routeHandler = handler
      }
    })

    const reply = { header: vi.fn(), statusCode: 0 }
    const result = await routeHandler?.({}, reply)

    expect(reply.header).toHaveBeenCalledWith('cache-control', 'no-store')
    expect(result).toEqual(expect.objectContaining({ metrics: expect.any(Object), layers: expect.any(Array) }))
  })

  it('sends forbidden bodies through reply.send when authorization fails', async () => {
    const cache = makeCache()
    const plugin = createFastifyLayercachePlugin(cache, {
      exposeStatsRoute: true,
      authorizeStatsRoute: async () => false
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

    const reply = { header: vi.fn(), send: vi.fn(), statusCode: 0 }
    const result = await routeHandler?.({}, reply)
    expect(reply.send).toHaveBeenCalledWith({ error: 'Forbidden' })
    expect(result).toBeUndefined()
  })

  it('grants access when authorizeStatsRoute returns true and allowPublicStatsRoute is false', async () => {
    const cache = makeCache()
    await cache.set('test:key', { data: 'value' })
    const plugin = createFastifyLayercachePlugin(cache, {
      exposeStatsRoute: true,
      allowPublicStatsRoute: false,
      authorizeStatsRoute: async (request) => request === 'authorized'
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

    // Without send method, body is returned directly (statusCode is not modified on success)
    const replyWithoutSend = { header: vi.fn(), statusCode: 0 }
    const result = await routeHandler?.('authorized', replyWithoutSend)

    expect(replyWithoutSend.statusCode).toBe(0) // statusCode is not set on success
    expect(result).toEqual(expect.objectContaining({ metrics: expect.any(Object), layers: expect.any(Array) }))

    // With send method, body is sent and undefined is returned
    const replyWithSend = { header: vi.fn(), send: vi.fn(), statusCode: 0 }
    const resultWithSend = await routeHandler?.('authorized', replyWithSend)

    expect(replyWithSend.send).toHaveBeenCalledWith(expect.objectContaining({ metrics: expect.any(Object) }))
    expect(resultWithSend).toBeUndefined()

    // Unauthorized request should set statusCode to 403
    const unauthorizedReply = { header: vi.fn(), statusCode: 0 }
    await routeHandler?.('unauthorized', unauthorizedReply)
    expect(unauthorizedReply.statusCode).toBe(403)
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

describe('HTTP cache middlewares', () => {
  it('falls back to res.end for express cache hits and preserves invalid URLs', async () => {
    const cache = makeCache()
    await cache.set('GET:http://[', { ok: true })
    const middleware = createExpressCacheMiddleware(cache, { allowPrivateCaching: true })
    const next = vi.fn()
    const res = {
      setHeader: vi.fn(),
      end: vi.fn()
    }

    await middleware({ method: 'GET', originalUrl: 'http://[' }, res, next)

    expect(res.end).toHaveBeenCalledWith(JSON.stringify({ ok: true }))
    expect(next).not.toHaveBeenCalled()
  })

  it('falls through for invalid hono URLs and unsupported methods', async () => {
    const cache = makeCache()
    const middleware = createHonoCacheMiddleware(cache, { allowPrivateCaching: true, methods: ['GET'] })
    const next = vi.fn(async () => undefined)
    const json = vi.fn()

    await middleware(
      {
        req: { method: 'POST', path: '/users' },
        json
      },
      next
    )

    await middleware(
      {
        req: { method: 'GET', path: 'http://[' },
        header: vi.fn(),
        json
      },
      next
    )

    expect(next).toHaveBeenCalledTimes(2)
  })
})

// ---------------------------------------------------------------------------
// tRPC middleware
// ---------------------------------------------------------------------------
describe('createTrpcCacheMiddleware', () => {
  it('caches procedure results', async () => {
    const cache = makeCache()
    const middleware = createTrpcCacheMiddleware(cache, 'proc', {
      ttl: 60_000,
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

  it('supports implicit context caching only when explicitly allowed', async () => {
    const cache = makeCache()
    const middleware = createTrpcCacheMiddleware(cache, 'proc', { allowImplicitContextCaching: true })
    let calls = 0
    const ctx = {
      path: 'listUsers',
      type: 'query',
      rawInput: { page: 1 },
      next: async () => {
        calls += 1
        return { ok: true, data: ['a'] }
      }
    }

    await middleware(ctx)
    await middleware(ctx)

    expect(calls).toBe(1)
  })

  it('falls back to next() when cache returns null without invoking the fetch wrapper', async () => {
    const cache = makeCache()
    const getSpy = vi.spyOn(cache, 'get').mockResolvedValueOnce(null)
    const middleware = createTrpcCacheMiddleware(cache, 'proc', { allowImplicitContextCaching: true })
    const next = vi.fn(async () => ({ ok: true, data: { id: 1 } }))

    await expect(middleware({ next, rawInput: { id: 1 } })).resolves.toEqual({ ok: true, data: { id: 1 } })
    expect(getSpy).toHaveBeenCalled()
    expect(next).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// Express middleware
// ---------------------------------------------------------------------------
describe('createExpressCacheMiddleware', () => {
  it('passes cache errors to next(error)', async () => {
    const cache = new CacheStack([new MemoryLayer({ ttl: 60_000 })])
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

  it('excludes sensitive query parameters from implicit express cache keys', async () => {
    const cache = makeCache()
    const setSpy = vi.spyOn(cache, 'set')
    const middleware = createExpressCacheMiddleware(cache, { allowPrivateCaching: true })
    const response = {
      setHeader: vi.fn(),
      json: vi.fn((body: unknown) => body)
    }

    await middleware({ method: 'GET', url: '/users?token=secret&b=2&code=oauth&a=1&session=abc' }, response, () => {
      response.json({ ok: true })
    })

    expect(setSpy).toHaveBeenCalledWith('GET:/users?a=1&b=2', { ok: true }, expect.any(Object))
  })

  it('falls back to res.end on cached hits when res.json is unavailable', async () => {
    const cache = makeCache()
    const middleware = createExpressCacheMiddleware(cache, {
      allowPrivateCaching: true,
      keyResolver: () => 'custom'
    })

    const missResponse = {
      setHeader: vi.fn(),
      json: vi.fn((body: unknown) => body),
      end: vi.fn()
    }

    await middleware({ method: 'GET', url: '/users' }, missResponse, () => {
      missResponse.json({ ok: true })
    })

    const hitResponse = {
      setHeader: vi.fn(),
      end: vi.fn()
    }

    await middleware({ method: 'GET', url: '/users' }, hitResponse, vi.fn())

    expect(hitResponse.end).toHaveBeenCalledWith(JSON.stringify({ ok: true }))
  })

  it('normalizes malformed express urls by falling back to the raw string', async () => {
    const cache = makeCache()
    const middleware = createExpressCacheMiddleware(cache, { allowPrivateCaching: true })
    let calls = 0

    const run = async () => {
      const response = { setHeader: vi.fn(), json: vi.fn((body: unknown) => body) }
      await middleware({ method: 'GET', url: '%%%broken-url%%%' }, response, () => {
        calls += 1
        response.json({ calls })
      })
    }

    await run()
    await run()
    expect(calls).toBe(1)
  })

  it('emits express cache write failures for non-Error rejections', async () => {
    const cache = makeCache()
    const emitSpy = vi.spyOn(cache, 'emit')
    cache.on('error', () => undefined)
    const originalSet = cache.set.bind(cache)
    cache.set = vi.fn(async () => {
      throw 'express-boom'
    }) as typeof cache.set

    const middleware = createExpressCacheMiddleware(cache, {
      allowPrivateCaching: true,
      keyResolver: () => 'express:error'
    })
    const response = {
      setHeader: vi.fn(),
      json: vi.fn((body: unknown) => body)
    }

    await middleware({ method: 'GET', url: '/users' }, response, () => {
      response.json({ ok: true })
    })
    await Promise.resolve()

    expect(emitSpy).toHaveBeenCalledWith('error', {
      operation: 'set',
      error: 'express-boom'
    })

    cache.set = originalSet
  })

  it('defaults express requests to GET, uses / when no URL is present, and formats Error write failures', async () => {
    const cache = makeCache()
    cache.on('error', () => undefined)
    const emitSpy = vi.spyOn(cache, 'emit')
    const originalSet = cache.set.bind(cache)
    cache.set = vi.fn(async () => {
      throw new Error('express-error')
    }) as typeof cache.set

    const middleware = createExpressCacheMiddleware(cache, {
      allowPrivateCaching: true
    })
    const response = {
      setHeader: vi.fn(),
      json: vi.fn((body: unknown) => body)
    }

    await middleware({}, response, () => {
      response.json({ ok: true })
    })
    await Promise.resolve()

    expect(emitSpy).toHaveBeenCalledWith('error', {
      operation: 'set',
      error: 'express-error'
    })

    cache.set = originalSet
  })

  it('respects custom key resolvers for private request contexts', async () => {
    const cache = makeCache()
    const middleware = createExpressCacheMiddleware(cache, {
      keyResolver: (request) => `${request.method}:${request.url}:${String(request.headers?.['x-tenant-id'])}`
    })
    let calls = 0

    const run = async (tenant: string) => {
      const response = {
        setHeader: vi.fn(),
        json: vi.fn((body: unknown) => body)
      }

      await middleware(
        {
          method: 'GET',
          url: '/users',
          headers: { 'x-tenant-id': tenant }
        },
        response,
        () => {
          calls += 1
          response.json?.({ tenant, calls })
        }
      )
    }

    await run('a')
    await run('a')
    await run('b')
    expect(calls).toBe(2)
  })

  it('bypasses unsupported express methods without touching the cache', async () => {
    const cache = makeCache()
    const getSpy = vi.spyOn(cache, 'get')
    const middleware = createExpressCacheMiddleware(cache, {
      allowPrivateCaching: true,
      methods: ['POST']
    })
    const next = vi.fn()

    await middleware({ method: 'GET', url: '/users' }, {}, next)

    expect(next).toHaveBeenCalledTimes(1)
    expect(getSpy).not.toHaveBeenCalled()
  })
})

describe('createHonoCacheMiddleware', () => {
  it('surfaces cache errors to the framework as a rejected middleware promise', async () => {
    const cache = new CacheStack([new MemoryLayer({ ttl: 60_000 })])
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

  it('excludes sensitive query parameters from implicit hono cache keys', async () => {
    const cache = makeCache()
    const setSpy = vi.spyOn(cache, 'set')
    const middleware = createHonoCacheMiddleware(cache, { allowPrivateCaching: true })
    const context = {
      req: { method: 'GET', path: '/users?token=secret&b=2&code=oauth&a=1&session=abc' },
      header: vi.fn(),
      json: vi.fn((body) => body)
    }

    await middleware(context, async () => {
      context.json({ ok: true })
    })

    expect(setSpy).toHaveBeenCalledWith('GET:/users?a=1&b=2', { ok: true }, expect.any(Object))
  })

  it('defaults hono requests without a method to GET and falls back to req.url when path is missing', async () => {
    const cache = makeCache()
    await cache.set('GET:/fallback', { ok: true })
    const middleware = createHonoCacheMiddleware(cache, { allowPrivateCaching: true })
    const header = vi.fn()
    const json = vi.fn((body) => body)

    const result = await middleware(
      {
        req: { url: '/fallback' },
        header,
        json
      },
      async () => undefined
    )

    expect(header).toHaveBeenCalledWith('x-cache', 'HIT')
    expect(result).toEqual({ ok: true })
  })

  it('uses / when hono path and url are both missing and formats Error write failures', async () => {
    const cache = makeCache()
    cache.on('error', () => undefined)
    const emitSpy = vi.spyOn(cache, 'emit')
    const originalSet = cache.set.bind(cache)
    cache.set = vi.fn(async () => {
      throw new Error('hono-error')
    }) as typeof cache.set

    const middleware = createHonoCacheMiddleware(cache, { allowPrivateCaching: true })
    const context = {
      req: {},
      header: vi.fn(),
      json: vi.fn((body) => body)
    }

    await middleware(context, async () => {
      context.json({ ok: true })
    })
    await Promise.resolve()

    expect(emitSpy).toHaveBeenCalledWith('error', {
      operation: 'set',
      error: 'hono-error'
    })

    cache.set = originalSet
  })

  it('supports custom key resolvers and bypasses disallowed methods', async () => {
    const cache = makeCache()
    const middleware = createHonoCacheMiddleware(cache, {
      methods: ['POST'],
      keyResolver: (request) => `tenant:${String(request.header?.('x-tenant-id') ?? 'unknown')}:${request.path ?? ''}`
    })
    let calls = 0

    const postContext = {
      req: {
        method: 'POST',
        path: '/users',
        header: (name: string) => (name === 'x-tenant-id' ? 'a' : undefined)
      },
      header: vi.fn(),
      json: vi.fn((body) => body)
    }

    await middleware(postContext, async () => {
      calls += 1
      postContext.json({ calls })
    })
    await middleware(postContext, async () => {
      calls += 1
      postContext.json({ calls })
    })

    const getContext = {
      req: { method: 'GET', path: '/users' },
      header: vi.fn(),
      json: vi.fn((body) => body)
    }
    await middleware(getContext, async () => {
      calls += 1
      getContext.json({ bypassed: true })
    })

    expect(calls).toBe(2)
  })

  it('bypasses hono requests without a keyResolver when private caching is disabled', async () => {
    const cache = makeCache()
    const getSpy = vi.spyOn(cache, 'get')
    const middleware = createHonoCacheMiddleware(cache)
    const next = vi.fn(async () => undefined)

    await middleware(
      {
        req: { method: 'GET', url: '/users' },
        json: (body) => body
      },
      next
    )

    expect(next).toHaveBeenCalledTimes(1)
    expect(getSpy).not.toHaveBeenCalled()
  })

  it('normalizes malformed hono urls by falling back to the raw string and emits cache write errors', async () => {
    const cache = makeCache()
    const onError = vi.fn()
    cache.on('error', onError)
    const emitSpy = vi.spyOn(cache, 'emit')
    const middleware = createHonoCacheMiddleware(cache, {
      allowPrivateCaching: true
    })

    const originalSet = cache.set.bind(cache)
    cache.set = vi.fn(async () => {
      throw 'boom'
    }) as typeof cache.set

    const context = {
      req: { method: 'GET', url: '%%%broken-url%%%' },
      header: vi.fn(),
      json: vi.fn((body) => body)
    }

    await middleware(context, async () => {
      context.json({ ok: true })
    })
    await Promise.resolve()

    expect(emitSpy).toHaveBeenCalledWith('error', {
      operation: 'set',
      error: 'boom'
    })
    expect(onError).toHaveBeenCalledWith({
      operation: 'set',
      error: 'boom'
    })

    cache.set = originalSet
  })
})
