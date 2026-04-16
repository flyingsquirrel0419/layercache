import type { CacheStack } from '../CacheStack'

interface FastifyLike {
  decorate: (name: string, value: unknown) => void
  get?: (path: string, handler: (request: unknown, reply: FastifyLikeReply) => unknown | Promise<unknown>) => void
}

interface FastifyLikeReply {
  header?: (name: string, value: string) => unknown
  send?: (body: unknown) => unknown
  statusCode?: number
}

interface FastifyLayercachePluginOptions {
  exposeStatsRoute?: boolean
  statsPath?: string
  /**
   * @deprecated Exposing cache stats without authentication is a security risk.
   * Provide an `authorizeStatsRoute` callback instead. This option will be
   * removed in a future release.
   */
  allowPublicStatsRoute?: boolean
  authorizeStatsRoute?: (request: unknown) => boolean | Promise<boolean>
  unauthorizedStatusCode?: number
}

export function createFastifyLayercachePlugin(cache: CacheStack, options: FastifyLayercachePluginOptions = {}) {
  if (options.exposeStatsRoute === true && options.allowPublicStatsRoute === true) {
    console.warn(
      '[layercache] WARNING: Cache stats route is publicly accessible without authentication. ' +
        'Set allowPublicStatsRoute: false (or provide an authorizeStatsRoute callback) before deploying to production.'
    )
  }

  return async (fastify: FastifyLike): Promise<void> => {
    fastify.decorate('cache', cache)

    if (options.exposeStatsRoute === true && fastify.get) {
      fastify.get(options.statsPath ?? '/cache/stats', async (request, reply) => {
        const isAuthorized =
          options.allowPublicStatsRoute === true ||
          (options.authorizeStatsRoute ? await options.authorizeStatsRoute(request) : false)

        reply.header?.('cache-control', 'no-store')
        reply.header?.('x-content-type-options', 'nosniff')

        if (!isAuthorized) {
          reply.statusCode = options.unauthorizedStatusCode ?? 403
          const body = { error: 'Forbidden' }
          if (reply.send) {
            reply.send(body)
            return
          }
          return body
        }

        const body = cache.getStats()
        if (reply.send) {
          reply.send(body)
          return
        }
        return body
      })
    }
  }
}
