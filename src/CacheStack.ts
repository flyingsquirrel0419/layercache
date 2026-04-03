import { randomUUID } from 'node:crypto'
import { createStoredValueEnvelope, remainingStoredTtlSeconds, resolveStoredValue } from './internal/StoredValue'
import { TagIndex } from './invalidation/TagIndex'
import { StampedeGuard } from './stampede/StampedeGuard'
import type {
  CacheGetOptions,
  CacheLayer,
  CacheLogger,
  CacheMGetEntry,
  CacheMetricsSnapshot,
  CacheMSetEntry,
  CacheSingleFlightExecutionOptions,
  CacheStackOptions,
  CacheTagIndex,
  CacheWriteOptions,
  InvalidationMessage,
  LayerTtlMap
} from './types'

const DEFAULT_NEGATIVE_TTL_SECONDS = 60
const DEFAULT_SINGLE_FLIGHT_LEASE_MS = 30_000
const DEFAULT_SINGLE_FLIGHT_TIMEOUT_MS = 5_000
const DEFAULT_SINGLE_FLIGHT_POLL_MS = 50

const EMPTY_METRICS = (): CacheMetricsSnapshot => ({
  hits: 0,
  misses: 0,
  fetches: 0,
  sets: 0,
  deletes: 0,
  backfills: 0,
  invalidations: 0,
  staleHits: 0,
  refreshes: 0,
  refreshErrors: 0,
  writeFailures: 0,
  singleFlightWaits: 0
})

type ReadMode = 'allow-stale' | 'fresh-only'
type CacheWriteKind = 'value' | 'empty'

type ReadHit<T> =
  | { found: true; value: T | null; stored: unknown; state: 'fresh' | 'stale-while-revalidate' | 'stale-if-error' }
  | { found: false; value: null; stored: null; state: 'miss' }

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
  private readonly backgroundRefreshes = new Map<string, Promise<void>>()

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

    const hit = await this.readFromLayers<T>(key, options, 'allow-stale')
    if (hit.found) {
      if (hit.state === 'fresh') {
        this.metrics.hits += 1
        return hit.value
      }

      if (hit.state === 'stale-while-revalidate') {
        this.metrics.hits += 1
        this.metrics.staleHits += 1
        if (fetcher) {
          this.scheduleBackgroundRefresh(key, fetcher, options)
        }
        return hit.value
      }

      if (!fetcher) {
        this.metrics.hits += 1
        this.metrics.staleHits += 1
        return hit.value
      }

      try {
        return await this.fetchWithGuards(key, fetcher, options)
      } catch (error) {
        this.metrics.staleHits += 1
        this.metrics.refreshErrors += 1
        this.logger.debug('stale-if-error', { key, error: this.formatError(error) })
        return hit.value
      }
    }

    this.metrics.misses += 1
    if (!fetcher) {
      return null
    }

    return this.fetchWithGuards(key, fetcher, options)
  }

  async set<T>(key: string, value: T, options?: CacheWriteOptions): Promise<void> {
    await this.startup
    await this.storeEntry(key, 'value', value, options)
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
    if (entries.length === 0) {
      return []
    }

    const canFastPath = entries.every((entry) => entry.fetch === undefined && entry.options === undefined)
    if (!canFastPath) {
      return Promise.all(entries.map((entry) => this.get(entry.key, entry.fetch, entry.options)))
    }

    await this.startup
    const pending = new Set(entries.map((_, index) => index))
    const results: Array<T | null> = Array(entries.length).fill(null)

    for (const layer of this.layers) {
      const indexes = [...pending]
      if (indexes.length === 0) {
        break
      }

      const keys = indexes.map((index) => entries[index].key)
      const values = layer.getMany
        ? await layer.getMany(keys)
        : await Promise.all(keys.map((key) => this.readLayerEntry(layer, key)))

      for (let offset = 0; offset < values.length; offset += 1) {
        const index = indexes[offset]
        const stored = values[offset]
        if (stored === null) {
          continue
        }

        const resolved = resolveStoredValue<T>(stored)
        if (resolved.state === 'expired') {
          await layer.delete(entries[index].key)
          continue
        }

        await this.tagIndex.touch(entries[index].key)
        await this.backfill(entries[index].key, stored, this.layers.indexOf(layer) - 1, entries[index].options)
        results[index] = resolved.value
        pending.delete(index)
        this.metrics.hits += 1
      }
    }

    if (pending.size > 0) {
      for (const index of pending) {
        await this.tagIndex.remove(entries[index].key)
        this.metrics.misses += 1
      }
    }

    return results
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
    await Promise.allSettled(this.backgroundRefreshes.values())
  }

  private async initialize(): Promise<void> {
    if (!this.options.invalidationBus) {
      return
    }

    this.unsubscribeInvalidation = await this.options.invalidationBus.subscribe(async (message) => {
      await this.handleInvalidationMessage(message)
    })
  }

  private async fetchWithGuards<T>(key: string, fetcher: () => Promise<T>, options?: CacheGetOptions): Promise<T | null> {
    const fetchTask = async (): Promise<T | null> => {
      const secondHit = await this.readFromLayers<T>(key, options, 'fresh-only')
      if (secondHit.found) {
        this.metrics.hits += 1
        return secondHit.value
      }

      return this.fetchAndPopulate(key, fetcher, options)
    }

    const singleFlightTask = async (): Promise<T | null> => {
      if (!this.options.singleFlightCoordinator) {
        return fetchTask()
      }

      return this.options.singleFlightCoordinator.execute(
        key,
        this.resolveSingleFlightOptions(),
        fetchTask,
        () => this.waitForFreshValue(key, fetcher, options)
      )
    }

    if (this.options.stampedePrevention === false) {
      return singleFlightTask()
    }

    return this.stampedeGuard.execute(key, singleFlightTask)
  }

  private async waitForFreshValue<T>(key: string, fetcher: () => Promise<T>, options?: CacheGetOptions): Promise<T | null> {
    const timeoutMs = this.options.singleFlightTimeoutMs ?? DEFAULT_SINGLE_FLIGHT_TIMEOUT_MS
    const pollIntervalMs = this.options.singleFlightPollMs ?? DEFAULT_SINGLE_FLIGHT_POLL_MS
    const deadline = Date.now() + timeoutMs

    this.metrics.singleFlightWaits += 1

    while (Date.now() < deadline) {
      const hit = await this.readFromLayers<T>(key, options, 'fresh-only')
      if (hit.found) {
        this.metrics.hits += 1
        return hit.value
      }
      await this.sleep(pollIntervalMs)
    }

    return this.fetchAndPopulate(key, fetcher, options)
  }

  private async fetchAndPopulate<T>(key: string, fetcher: () => Promise<T>, options?: CacheGetOptions): Promise<T | null> {
    this.metrics.fetches += 1
    const fetched = await fetcher()

    if (fetched === null || fetched === undefined) {
      if (!this.shouldNegativeCache(options)) {
        return null
      }

      await this.storeEntry(key, 'empty', null, options)
      return null
    }

    await this.storeEntry(key, 'value', fetched, options)
    return fetched
  }

  private async storeEntry(key: string, kind: CacheWriteKind, value: unknown, options?: CacheWriteOptions): Promise<void> {
    await this.writeAcrossLayers(key, kind, value, options)
    if (options?.tags) {
      await this.tagIndex.track(key, options.tags)
    } else {
      await this.tagIndex.touch(key)
    }

    this.metrics.sets += 1
    this.logger.debug('set', { key, kind, tags: options?.tags })
    if (this.options.publishSetInvalidation !== false) {
      await this.publishInvalidation({ scope: 'key', keys: [key], sourceId: this.instanceId, operation: 'write' })
    }
  }

  private async readFromLayers<T>(key: string, options: CacheGetOptions | undefined, mode: ReadMode): Promise<ReadHit<T>> {
    let sawRetainableValue = false

    for (let index = 0; index < this.layers.length; index += 1) {
      const layer = this.layers[index]
      const stored = await this.readLayerEntry(layer, key)
      if (stored === null) {
        continue
      }

      const resolved = resolveStoredValue<T>(stored)
      if (resolved.state === 'expired') {
        await layer.delete(key)
        continue
      }

      sawRetainableValue = true

      if (mode === 'fresh-only' && resolved.state !== 'fresh') {
        continue
      }

      await this.tagIndex.touch(key)
      await this.backfill(key, stored, index - 1, options)
      this.logger.debug('hit', { key, layer: layer.name, state: resolved.state })
      return { found: true, value: resolved.value, stored, state: resolved.state }
    }

    if (!sawRetainableValue) {
      await this.tagIndex.remove(key)
    }

    this.logger.debug('miss', { key, mode })
    return { found: false, value: null, stored: null, state: 'miss' }
  }

  private async readLayerEntry(layer: CacheLayer, key: string): Promise<unknown | null> {
    if (layer.getEntry) {
      return layer.getEntry(key)
    }

    return layer.get(key)
  }

  private async backfill(key: string, stored: unknown, upToIndex: number, options?: CacheGetOptions): Promise<void> {
    if (upToIndex < 0) {
      return
    }

    for (let index = 0; index <= upToIndex; index += 1) {
      const layer = this.layers[index]
      const ttl = remainingStoredTtlSeconds(stored) ?? this.resolveLayerSeconds(layer.name, options?.ttl, undefined, layer.defaultTtl)
      await layer.set(key, stored, ttl)
      this.metrics.backfills += 1
      this.logger.debug('backfill', { key, layer: layer.name })
    }
  }

  private async writeAcrossLayers(
    key: string,
    kind: CacheWriteKind,
    value: unknown,
    options?: CacheWriteOptions
  ): Promise<void> {
    const now = Date.now()
    const operations = this.layers.map((layer) => async () => {
      const freshTtl = this.resolveFreshTtl(layer.name, kind, options, layer.defaultTtl)
      const staleWhileRevalidate = this.resolveLayerSeconds(
        layer.name,
        options?.staleWhileRevalidate,
        this.options.staleWhileRevalidate
      )
      const staleIfError = this.resolveLayerSeconds(
        layer.name,
        options?.staleIfError,
        this.options.staleIfError
      )
      const payload = createStoredValueEnvelope({
        kind,
        value,
        freshTtlSeconds: freshTtl,
        staleWhileRevalidateSeconds: staleWhileRevalidate,
        staleIfErrorSeconds: staleIfError,
        now
      })
      const ttl = remainingStoredTtlSeconds(payload, now) ?? freshTtl
      await layer.set(key, payload, ttl)
    })

    await this.executeLayerOperations(operations, { key, action: kind === 'empty' ? 'negative-set' : 'set' })
  }

  private async executeLayerOperations(
    operations: Array<() => Promise<void>>,
    context: { key: string; action: string }
  ): Promise<void> {
    if (this.options.writePolicy !== 'best-effort') {
      await Promise.all(operations.map((operation) => operation()))
      return
    }

    const results = await Promise.allSettled(operations.map((operation) => operation()))
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (failures.length === 0) {
      return
    }

    this.metrics.writeFailures += failures.length
    this.logger.debug('write-failure', {
      ...context,
      failures: failures.map((failure) => this.formatError(failure.reason))
    })

    if (failures.length === operations.length) {
      throw new AggregateError(
        failures.map((failure) => failure.reason),
        `${context.action} failed for every cache layer`
      )
    }
  }

  private resolveFreshTtl(
    layerName: string,
    kind: CacheWriteKind,
    options: CacheWriteOptions | undefined,
    fallbackTtl: number | undefined
  ): number | undefined {
    const baseTtl = kind === 'empty'
      ? this.resolveLayerSeconds(
          layerName,
          options?.negativeTtl,
          this.options.negativeTtl,
          this.resolveLayerSeconds(layerName, options?.ttl, undefined, fallbackTtl) ?? DEFAULT_NEGATIVE_TTL_SECONDS
        )
      : this.resolveLayerSeconds(layerName, options?.ttl, undefined, fallbackTtl)

    const jitter = this.resolveLayerSeconds(layerName, options?.ttlJitter, this.options.ttlJitter)
    return this.applyJitter(baseTtl, jitter)
  }

  private resolveLayerSeconds(
    layerName: string,
    override: number | LayerTtlMap | undefined,
    globalDefault?: number | LayerTtlMap,
    fallback?: number
  ): number | undefined {
    if (override !== undefined) {
      return this.readLayerNumber(layerName, override) ?? fallback
    }

    if (globalDefault !== undefined) {
      return this.readLayerNumber(layerName, globalDefault) ?? fallback
    }

    return fallback
  }

  private readLayerNumber(layerName: string, value: number | LayerTtlMap): number | undefined {
    if (typeof value === 'number') {
      return value
    }

    return value[layerName]
  }

  private applyJitter(ttl: number | undefined, jitter: number | undefined): number | undefined {
    if (!ttl || ttl <= 0 || !jitter || jitter <= 0) {
      return ttl
    }

    const delta = (Math.random() * 2 - 1) * jitter
    return Math.max(1, Math.round(ttl + delta))
  }

  private shouldNegativeCache(options?: CacheGetOptions): boolean {
    return options?.negativeCache ?? this.options.negativeCaching ?? false
  }

  private scheduleBackgroundRefresh<T>(key: string, fetcher: () => Promise<T>, options?: CacheGetOptions): void {
    if (this.backgroundRefreshes.has(key)) {
      return
    }

    const refresh = (async () => {
      this.metrics.refreshes += 1
      try {
        await this.fetchWithGuards(key, fetcher, options)
      } catch (error) {
        this.metrics.refreshErrors += 1
        this.logger.debug('refresh-error', { key, error: this.formatError(error) })
      } finally {
        this.backgroundRefreshes.delete(key)
      }
    })()

    this.backgroundRefreshes.set(key, refresh)
  }

  private resolveSingleFlightOptions(): CacheSingleFlightExecutionOptions {
    return {
      leaseMs: this.options.singleFlightLeaseMs ?? DEFAULT_SINGLE_FLIGHT_LEASE_MS,
      waitTimeoutMs: this.options.singleFlightTimeoutMs ?? DEFAULT_SINGLE_FLIGHT_TIMEOUT_MS,
      pollIntervalMs: this.options.singleFlightPollMs ?? DEFAULT_SINGLE_FLIGHT_POLL_MS
    }
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

  private formatError(error: unknown): string {
    if (error instanceof Error) {
      return error.message
    }

    return String(error)
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}
