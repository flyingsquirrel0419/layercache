import type { CacheStack } from '../CacheStack'

interface FastifyLike {
  decorate: (name: string, value: unknown) => void
  get?: (path: string, handler: () => unknown | Promise<unknown>) => void
}

interface FastifyLayercachePluginOptions {
  exposeStatsRoute?: boolean
  statsPath?: string
}

export function createFastifyLayercachePlugin(cache: CacheStack, options: FastifyLayercachePluginOptions = {}) {
  return async (fastify: FastifyLike): Promise<void> => {
    fastify.decorate('cache', cache)

    if (options.exposeStatsRoute === true && fastify.get) {
      fastify.get(options.statsPath ?? '/cache/stats', async () => cache.getStats())
    }
  }
}
