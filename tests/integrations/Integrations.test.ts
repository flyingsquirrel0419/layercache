import { describe, expect, it, vi } from 'vitest'
import { CacheStack } from '../../src/CacheStack'
import { MemoryLayer } from '../../src/layers/MemoryLayer'
import { createCacheStatsHandler } from '../../src/http/createCacheStatsHandler'
import { createFastifyLayercachePlugin } from '../../src/integrations/fastify'
import { cacheGraphqlResolver } from '../../src/integrations/graphql'
import { createTrpcCacheMiddleware } from '../../src/integrations/trpc'

function makeCache() {
  return new CacheStack([new MemoryLayer({ ttl: 60 })])
}

// ---------------------------------------------------------------------------
// HTTP stats handler
// ---------------------------------------------------------------------------
describe('createCacheStatsHandler', () => {
  it('writes JSON stats with status 200', async () => {
    const cache = makeCache()
    const handler = createCacheStatsHandler(cache)

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
      decorate: (name: string, value: unknown) => { decorations[name] = value },
      get: vi.fn()
    }

    await plugin(fastify)
    expect(decorations['cache']).toBe(cache)
    expect(fastify.get).not.toHaveBeenCalled()
  })

  it('registers stats route when exposeStatsRoute is true', async () => {
    const cache = makeCache()
    const plugin = createFastifyLayercachePlugin(cache, { exposeStatsRoute: true, statsPath: '/stats' })
    const registeredRoutes: string[] = []
    const fastify = {
      decorate: vi.fn(),
      get: (path: string) => { registeredRoutes.push(path) }
    }

    await plugin(fastify)
    expect(registeredRoutes).toContain('/stats')
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

    const cached = cacheGraphqlResolver(cache, 'user', resolver)
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
})

// ---------------------------------------------------------------------------
// tRPC middleware
// ---------------------------------------------------------------------------
describe('createTrpcCacheMiddleware', () => {
  it('caches procedure results', async () => {
    const cache = makeCache()
    const middleware = createTrpcCacheMiddleware(cache, 'proc', { ttl: 60 })

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
    const middleware = createTrpcCacheMiddleware(cache, 'fresh')

    const ctx = {
      path: 'ping',
      rawInput: null,
      next: async () => ({ ok: true, data: 'pong' })
    }

    const result = await middleware(ctx)
    expect(result).toEqual({ ok: true, data: 'pong' })
  })
})
