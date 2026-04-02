import { randomUUID } from 'node:crypto'
import { TagIndex } from './invalidation/TagIndex'
import { StampedeGuard } from './stampede/StampedeGuard'
import type {
  CacheStackOptions,
  CacheGetOptions,
  CacheLayer,
  CacheLogger,
  CacheMGetEntry,
  CacheMetricsSnapshot,
  CacheMSetEntry,
  CacheTagIndex,
  CacheWriteOptions,
  InvalidationMessage
} from './types'

const EMPTY_METRICS = (): CacheMetricsSnapshot => ({
  hits: 0,
  misses: 0,
  fetches: 0,
  sets: 0,
  deletes: 0,
  backfills: 0,
  invalidations: 0
})

class DebugLogger implements CacheLogger {
  private readonly enabled: boolean

  constructor(enabled: boolean) {
    this.enabled = enabled
  }

  debug(message: string, context?: Record<string, unknown>): void {
    if (!this.enabled) {
      return
    }

    const suffix = context ? ` ${JSON.stringify(context)}` : ''
    console.debug(`[layercache] ${message}${suffix}`)
  }
}

export class CacheStack {
  private readonly stampedeGuard = new StampedeGuard()
  private readonly metrics = EMPTY_METRICS()
  private readonly instanceId = randomUUID()
  private readonly startup: Promise<void>
  private unsubscribeInvalidation?: () => Promise<void> | void
  private readonly logger: CacheLogger
  private readonly tagIndex: CacheTagIndex

  constructor(
    private readonly layers: CacheLayer[],
    private readonly options: CacheStackOptions = {}
  ) {
    if (layers.length === 0) {
      throw new Error('CacheStack requires at least one cache layer.')
    }

    const debugEnv = process.env.DEBUG?.split(',').includes('layercache:debug') ?? false
    this.logger = typeof options.logger === 'object' ? options.logger : new DebugLogger(Boolean(options.logger) || debugEnv)
    this.tagIndex = options.tagIndex ?? new TagIndex()
    this.startup = this.initialize()
  }

  async get<T>(key: string, fetcher?: () => Promise<T>, options?: CacheGetOptions): Promise<T | null> {
    await this.startup

    const hit = await this.getFromLayers<T>(key, options)
    if (hit.found) {
      this.metrics.hits += 1
      return hit.value
    }

    this.metrics.misses += 1
    if (!fetcher) {
      return null
    }

    const runFetch = async (): Promise<T | null> => {
      const secondHit = await this.getFromLayers<T>(key, options)
      if (secondHit.found) {
        this.metrics.hits += 1
        return secondHit.value
      }

      this.metrics.fetches += 1
      const fetched = await fetcher()
      if (fetched === null || fetched === undefined) {
        return null
      }

      await this.set(key, fetched, options)
      return fetched
    }

    if (this.options.stampedePrevention === false) {
      return runFetch()
    }

    return this.stampedeGuard.execute(key, runFetch)
  }

  async set<T>(key: string, value: T, options?: CacheWriteOptions): Promise<void> {
    await this.startup
    await this.setAcrossLayers(key, value, options)
    if (options?.tags) {
      await this.tagIndex.track(key, options.tags)
    } else {
      await this.tagIndex.touch(key)
    }

    this.metrics.sets += 1
    this.logger.debug('set', { key, tags: options?.tags })
    if (this.options.publishSetInvalidation !== false) {
      await this.publishInvalidation({ scope: 'key', keys: [key], sourceId: this.instanceId, operation: 'write' })
    }
  }

  async delete(key: string): Promise<void> {
    await this.startup
    await this.deleteKeys([key])
    await this.publishInvalidation({ scope: 'key', keys: [key], sourceId: this.instanceId, operation: 'delete' })
  }

  async clear(): Promise<void> {
    await this.startup
    await Promise.all(this.layers.map((layer) => layer.clear()))
    await this.tagIndex.clear()
    this.metrics.invalidations += 1
    this.logger.debug('clear')
    await this.publishInvalidation({ scope: 'clear', sourceId: this.instanceId, operation: 'clear' })
  }

  async mget<T>(entries: CacheMGetEntry<T>[]): Promise<Array<T | null>> {
    return Promise.all(entries.map((entry) => this.get(entry.key, entry.fetch, entry.options)))
  }

  async mset<T>(entries: CacheMSetEntry<T>[]): Promise<void> {
    await Promise.all(entries.map((entry) => this.set(entry.key, entry.value, entry.options)))
  }

  async invalidateByTag(tag: string): Promise<void> {
    await this.startup
    const keys = await this.tagIndex.keysForTag(tag)
    await this.deleteKeys(keys)
    await this.publishInvalidation({ scope: 'keys', keys, sourceId: this.instanceId, operation: 'invalidate' })
  }

  async invalidateByPattern(pattern: string): Promise<void> {
    await this.startup
    const keys = await this.tagIndex.matchPattern(pattern)
    await this.deleteKeys(keys)
    await this.publishInvalidation({ scope: 'keys', keys, sourceId: this.instanceId, operation: 'invalidate' })
  }

  getMetrics(): CacheMetricsSnapshot {
    return { ...this.metrics }
  }

  resetMetrics(): void {
    Object.assign(this.metrics, EMPTY_METRICS())
  }

  async disconnect(): Promise<void> {
    await this.startup
    await this.unsubscribeInvalidation?.()
  }

  private async initialize(): Promise<void> {
    if (!this.options.invalidationBus) {
      return
    }

    this.unsubscribeInvalidation = await this.options.invalidationBus.subscribe(async (message) => {
      await this.handleInvalidationMessage(message)
    })
  }

  private async getFromLayers<T>(
    key: string,
    options?: CacheGetOptions
  ): Promise<{ found: true; value: T } | { found: false; value: null }> {
    for (let index = 0; index < this.layers.length; index += 1) {
      const layer = this.layers[index]
      const value = await layer.get<T>(key)
      if (value === null) {
        continue
      }

      await this.tagIndex.touch(key)
      await this.backfill(key, value, index - 1, options)
      this.logger.debug('hit', { key, layer: layer.name })
      return { found: true, value }
    }

    await this.tagIndex.remove(key)
    this.logger.debug('miss', { key })
    return { found: false, value: null }
  }

  private async backfill(key: string, value: unknown, upToIndex: number, options?: CacheGetOptions): Promise<void> {
    if (upToIndex < 0) {
      return
    }

    for (let index = 0; index <= upToIndex; index += 1) {
      const layer = this.layers[index]
      await layer.set(key, value, this.resolveTtl(layer.name, layer.defaultTtl, options?.ttl))
      this.metrics.backfills += 1
      this.logger.debug('backfill', { key, layer: layer.name })
    }
  }

  private async setAcrossLayers(key: string, value: unknown, options?: CacheWriteOptions): Promise<void> {
    await Promise.all(
      this.layers.map((layer) => layer.set(key, value, this.resolveTtl(layer.name, layer.defaultTtl, options?.ttl)))
    )
  }

  private resolveTtl(
    layerName: string,
    fallbackTtl: number | undefined,
    ttlOverride?: number | Record<string, number | undefined>
  ): number | undefined {
    if (ttlOverride === undefined) {
      return fallbackTtl
    }

    if (typeof ttlOverride === 'number') {
      return ttlOverride
    }

    return ttlOverride[layerName] ?? fallbackTtl
  }

  private async deleteKeys(keys: string[]): Promise<void> {
    if (keys.length === 0) {
      return
    }

    await Promise.all(
      this.layers.map(async (layer) => {
        if (layer.deleteMany) {
          await layer.deleteMany(keys)
          return
        }

        await Promise.all(keys.map((key) => layer.delete(key)))
      })
    )

    for (const key of keys) {
      await this.tagIndex.remove(key)
    }

    this.metrics.deletes += keys.length
    this.metrics.invalidations += 1
    this.logger.debug('delete', { keys })
  }

  private async publishInvalidation(message: InvalidationMessage): Promise<void> {
    if (!this.options.invalidationBus) {
      return
    }

    await this.options.invalidationBus.publish(message)
  }

  private async handleInvalidationMessage(message: InvalidationMessage): Promise<void> {
    if (message.sourceId === this.instanceId) {
      return
    }

    const localLayers = this.layers.filter((layer) => layer.isLocal)
    if (localLayers.length === 0) {
      return
    }

    if (message.scope === 'clear') {
      await Promise.all(localLayers.map((layer) => layer.clear()))
      await this.tagIndex.clear()
      return
    }

    const keys = message.keys ?? []
    await Promise.all(
      localLayers.map(async (layer) => {
        if (layer.deleteMany) {
          await layer.deleteMany(keys)
          return
        }
        await Promise.all(keys.map((key) => layer.delete(key)))
      })
    )

    if (message.operation !== 'write') {
      for (const key of keys) {
        await this.tagIndex.remove(key)
      }
    }
  }
}
