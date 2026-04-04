import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { EventEmitter } from 'node:events'
import {
  createStoredValueEnvelope,
  isStoredValueEnvelope,
  refreshStoredEnvelope,
  remainingFreshTtlSeconds,
  remainingStoredTtlSeconds,
  resolveStoredValue
} from './internal/StoredValue'
import { CacheNamespace } from './CacheNamespace'
import { TagIndex } from './invalidation/TagIndex'
import { StampedeGuard } from './stampede/StampedeGuard'
import type {
  CacheAdaptiveTtlOptions,
  CacheCircuitBreakerOptions,
  CacheGetOptions,
  CacheLayer,
  CacheLogger,
  CacheMGetEntry,
  CacheMetricsSnapshot,
  CacheMSetEntry,
  CacheSingleFlightExecutionOptions,
  CacheSnapshotEntry,
  CacheStackOptions,
  CacheStatsSnapshot,
  CacheTagIndex,
  CacheWarmEntry,
  CacheWarmOptions,
  CacheWrapOptions,
  CacheWriteOptions,
  InvalidationMessage,
  LayerTtlMap
} from './types'

const DEFAULT_NEGATIVE_TTL_SECONDS = 60
const DEFAULT_SINGLE_FLIGHT_LEASE_MS = 30_000
const DEFAULT_SINGLE_FLIGHT_TIMEOUT_MS = 5_000
const DEFAULT_SINGLE_FLIGHT_POLL_MS = 50
const MAX_CACHE_KEY_LENGTH = 1_024

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
  singleFlightWaits: 0,
  negativeCacheHits: 0,
  circuitBreakerTrips: 0,
  degradedOperations: 0,
  hitsByLayer: {},
  missesByLayer: {}
})

type ReadMode = 'allow-stale' | 'fresh-only'
type CacheWriteKind = 'value' | 'empty'

type ReadHit<T> =
  | { found: true; value: T | null; stored: unknown; state: 'fresh' | 'stale-while-revalidate' | 'stale-if-error'; layerIndex: number; layerName: string }
  | { found: false; value: null; stored: null; state: 'miss' }

class DebugLogger implements CacheLogger {
  private readonly enabled: boolean

  constructor(enabled: boolean) {
    this.enabled = enabled
  }

  debug(message: string, context?: Record<string, unknown>): void {
    this.write('debug', message, context)
  }

  info(message: string, context?: Record<string, unknown>): void {
    this.write('info', message, context)
  }

  warn(message: string, context?: Record<string, unknown>): void {
    this.write('warn', message, context)
  }

  error(message: string, context?: Record<string, unknown>): void {
    this.write('error', message, context)
  }

  private write(level: 'debug' | 'info' | 'warn' | 'error', message: string, context?: Record<string, unknown>): void {
    if (!this.enabled) {
      return
    }

    const suffix = context ? ` ${JSON.stringify(context)}` : ''
    console[level](`[layercache] ${message}${suffix}`)
  }
}

interface AccessProfile {
  hits: number
  lastAccessAt: number
}

interface CircuitBreakerState {
  failures: number
  openUntil: number | null
}

export class CacheStack extends EventEmitter {
  private readonly stampedeGuard = new StampedeGuard()
  private readonly metrics = EMPTY_METRICS()
  private readonly instanceId = randomUUID()
  private readonly startup: Promise<void>
  private unsubscribeInvalidation?: () => Promise<void> | void
  private readonly logger: CacheLogger
  private readonly tagIndex: CacheTagIndex
  private readonly backgroundRefreshes = new Map<string, Promise<void>>()
  private readonly accessProfiles = new Map<string, AccessProfile>()
  private readonly layerDegradedUntil = new Map<string, number>()
  private readonly circuitBreakers = new Map<string, CircuitBreakerState>()
  private isDisconnecting = false
  private disconnectPromise?: Promise<void>

  constructor(
    private readonly layers: CacheLayer[],
    private readonly options: CacheStackOptions = {}
  ) {
    super()

    if (layers.length === 0) {
      throw new Error('CacheStack requires at least one cache layer.')
    }

    this.validateConfiguration()

    const debugEnv = process.env.DEBUG?.split(',').includes('layercache:debug') ?? false
    this.logger = typeof options.logger === 'object' ? options.logger : new DebugLogger(Boolean(options.logger) || debugEnv)
    this.tagIndex = options.tagIndex ?? new TagIndex()
    this.startup = this.initialize()
  }

  async get<T>(key: string, fetcher?: () => Promise<T>, options?: CacheGetOptions): Promise<T | null> {
    const normalizedKey = this.validateCacheKey(key)
    this.validateWriteOptions(options)
    await this.startup

    const hit = await this.readFromLayers<T>(normalizedKey, options, 'allow-stale')
    if (hit.found) {
      this.recordAccess(normalizedKey)
      if (this.isNegativeStoredValue(hit.stored)) {
        this.metrics.negativeCacheHits += 1
      }

      if (hit.state === 'fresh') {
        this.metrics.hits += 1
        await this.applyFreshReadPolicies(normalizedKey, hit, options, fetcher)
        return hit.value
      }

      if (hit.state === 'stale-while-revalidate') {
        this.metrics.hits += 1
        this.metrics.staleHits += 1
        this.emit('stale-serve', { key: normalizedKey, state: hit.state, layer: hit.layerName })
        if (fetcher) {
          this.scheduleBackgroundRefresh(normalizedKey, fetcher, options)
        }
        return hit.value
      }

      if (!fetcher) {
        this.metrics.hits += 1
        this.metrics.staleHits += 1
        this.emit('stale-serve', { key: normalizedKey, state: hit.state, layer: hit.layerName })
        return hit.value
      }

      try {
        return await this.fetchWithGuards(normalizedKey, fetcher, options)
      } catch (error) {
        this.metrics.staleHits += 1
        this.metrics.refreshErrors += 1
        this.logger.debug?.('stale-if-error', { key: normalizedKey, error: this.formatError(error) })
        return hit.value
      }
    }

    this.metrics.misses += 1
    if (!fetcher) {
      return null
    }

    return this.fetchWithGuards(normalizedKey, fetcher, options)
  }

  async set<T>(key: string, value: T, options?: CacheWriteOptions): Promise<void> {
    const normalizedKey = this.validateCacheKey(key)
    this.validateWriteOptions(options)
    await this.startup
    await this.storeEntry(normalizedKey, 'value', value, options)
  }

  async delete(key: string): Promise<void> {
    const normalizedKey = this.validateCacheKey(key)
    await this.startup
    await this.deleteKeys([normalizedKey])
    await this.publishInvalidation({ scope: 'key', keys: [normalizedKey], sourceId: this.instanceId, operation: 'delete' })
  }

  async clear(): Promise<void> {
    await this.startup
    await Promise.all(this.layers.map((layer) => layer.clear()))
    await this.tagIndex.clear()
    this.accessProfiles.clear()
    this.metrics.invalidations += 1
    this.logger.debug?.('clear')
    await this.publishInvalidation({ scope: 'clear', sourceId: this.instanceId, operation: 'clear' })
  }

  async mget<T>(entries: CacheMGetEntry<T>[]): Promise<Array<T | null>> {
    if (entries.length === 0) {
      return []
    }

    const normalizedEntries = entries.map((entry) => ({
      ...entry,
      key: this.validateCacheKey(entry.key)
    }))
    normalizedEntries.forEach((entry) => this.validateWriteOptions(entry.options))
    const canFastPath = normalizedEntries.every((entry) => entry.fetch === undefined && entry.options === undefined)
    if (!canFastPath) {
      const pendingReads = new Map<string, {
        promise: Promise<T | null>
        fetch?: () => Promise<T>
        optionsSignature: string
      }>()

      return Promise.all(
        normalizedEntries.map((entry) => {
          const optionsSignature = this.serializeOptions(entry.options)
          const existing = pendingReads.get(entry.key)
          if (!existing) {
            const promise = this.get(entry.key, entry.fetch, entry.options)
            pendingReads.set(entry.key, {
              promise,
              fetch: entry.fetch,
              optionsSignature
            })
            return promise
          }

          if (existing.fetch !== entry.fetch || existing.optionsSignature !== optionsSignature) {
            throw new Error(`mget received conflicting entries for key "${entry.key}".`)
          }

          return existing.promise
        })
      )
    }

    await this.startup
    const pending = new Set<string>()
    const indexesByKey = new Map<string, number[]>()
    const resultsByKey = new Map<string, T | null>()

    for (let index = 0; index < normalizedEntries.length; index += 1) {
      const key = normalizedEntries[index].key
      const indexes = indexesByKey.get(key) ?? []
      indexes.push(index)
      indexesByKey.set(key, indexes)
      pending.add(key)
    }

    for (let layerIndex = 0; layerIndex < this.layers.length; layerIndex += 1) {
      const layer = this.layers[layerIndex]
      const keys = [...pending]
      if (keys.length === 0) {
        break
      }

      const values = layer.getMany
        ? await layer.getMany(keys)
        : await Promise.all(keys.map((key) => this.readLayerEntry(layer, key)))

      for (let offset = 0; offset < values.length; offset += 1) {
        const key = keys[offset]
        const stored = values[offset]
        if (stored === null) {
          continue
        }

        const resolved = resolveStoredValue<T>(stored)
        if (resolved.state === 'expired') {
          await layer.delete(key)
          continue
        }

        await this.tagIndex.touch(key)
        await this.backfill(key, stored, layerIndex - 1)
        resultsByKey.set(key, resolved.value)
        pending.delete(key)
        this.metrics.hits += indexesByKey.get(key)?.length ?? 1
      }
    }

    if (pending.size > 0) {
      for (const key of pending) {
        await this.tagIndex.remove(key)
        this.metrics.misses += indexesByKey.get(key)?.length ?? 1
      }
    }

    return normalizedEntries.map((entry) => resultsByKey.get(entry.key) ?? null)
  }

  async mset<T>(entries: CacheMSetEntry<T>[]): Promise<void> {
    const normalizedEntries = entries.map((entry) => ({
      ...entry,
      key: this.validateCacheKey(entry.key)
    }))
    normalizedEntries.forEach((entry) => this.validateWriteOptions(entry.options))

    await Promise.all(normalizedEntries.map((entry) => this.set(entry.key, entry.value, entry.options)))
  }

  async warm(entries: CacheWarmEntry[], options: CacheWarmOptions = {}): Promise<void> {
    const concurrency = Math.max(1, options.concurrency ?? 4)
    const queue = [...entries].sort((left, right) => (right.priority ?? 0) - (left.priority ?? 0))
    const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
      while (queue.length > 0) {
        const entry = queue.shift()
        if (!entry) {
          return
        }

        try {
          await this.get(entry.key, entry.fetcher, entry.options)
          this.emit('warm', { key: entry.key })
        } catch (error) {
          this.emitError('warm', { key: entry.key, error: this.formatError(error) })
          if (!options.continueOnError) {
            throw error
          }
        }
      }
    })

    await Promise.all(workers)
  }

  wrap<TArgs extends unknown[], TResult>(
    prefix: string,
    fetcher: (...args: TArgs) => Promise<TResult>,
    options: CacheWrapOptions<TArgs> = {}
  ): (...args: TArgs) => Promise<TResult | null> {
    return (...args: TArgs) => {
      const suffix = options.keyResolver
        ? options.keyResolver(...args)
        : args.map((argument) => this.serializeKeyPart(argument)).join(':')
      const key = suffix.length > 0 ? `${prefix}:${suffix}` : prefix
      return this.get<TResult>(key, () => fetcher(...args), options)
    }
  }

  namespace(prefix: string): CacheNamespace {
    return new CacheNamespace(this, prefix)
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

  getStats(): CacheStatsSnapshot {
    return {
      metrics: this.getMetrics(),
      layers: this.layers.map((layer) => ({
        name: layer.name,
        isLocal: Boolean(layer.isLocal),
        degradedUntil: this.layerDegradedUntil.get(layer.name) ?? null
      })),
      backgroundRefreshes: this.backgroundRefreshes.size
    }
  }

  resetMetrics(): void {
    Object.assign(this.metrics, EMPTY_METRICS())
  }

  async exportState(): Promise<CacheSnapshotEntry[]> {
    await this.startup
    const exported = new Map<string, CacheSnapshotEntry>()

    for (const layer of this.layers) {
      if (!layer.keys) {
        continue
      }

      const keys = await layer.keys()
      for (const key of keys) {
        if (exported.has(key)) {
          continue
        }

        const stored = await this.readLayerEntry(layer, key)
        if (stored === null) {
          continue
        }

        exported.set(key, {
          key,
          value: stored,
          ttl: remainingStoredTtlSeconds(stored)
        })
      }
    }

    return [...exported.values()]
  }

  async importState(entries: CacheSnapshotEntry[]): Promise<void> {
    await this.startup
    await Promise.all(entries.map(async (entry) => {
      await Promise.all(this.layers.map((layer) => layer.set(entry.key, entry.value, entry.ttl)))
      await this.tagIndex.touch(entry.key)
    }))
  }

  async persistToFile(filePath: string): Promise<void> {
    const snapshot = await this.exportState()
    await fs.writeFile(filePath, JSON.stringify(snapshot, null, 2), 'utf8')
  }

  async restoreFromFile(filePath: string): Promise<void> {
    const raw = await fs.readFile(filePath, 'utf8')
    const snapshot = JSON.parse(raw)
    if (!this.isCacheSnapshotEntries(snapshot)) {
      throw new Error('Invalid snapshot file: expected CacheSnapshotEntry[]')
    }
    await this.importState(snapshot)
  }

  async disconnect(): Promise<void> {
    if (!this.disconnectPromise) {
      this.isDisconnecting = true
      this.disconnectPromise = (async () => {
        await this.startup
        await this.unsubscribeInvalidation?.()
        await Promise.allSettled([...this.backgroundRefreshes.values()])
      })()
    }

    await this.disconnectPromise
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
    this.emit('stampede-dedupe', { key })

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
    this.assertCircuitClosed(key, options?.circuitBreaker ?? this.options.circuitBreaker)
    this.metrics.fetches += 1
    let fetched: T

    try {
      fetched = await fetcher()
      this.resetCircuitBreaker(key)
    } catch (error) {
      this.recordCircuitFailure(key, options?.circuitBreaker ?? this.options.circuitBreaker, error)
      throw error
    }

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
    this.logger.debug?.('set', { key, kind, tags: options?.tags })
    this.emit('set', { key, kind, tags: options?.tags })
    if (this.shouldBroadcastL1Invalidation()) {
      await this.publishInvalidation({ scope: 'key', keys: [key], sourceId: this.instanceId, operation: 'write' })
    }
  }

  private async readFromLayers<T>(key: string, options: CacheGetOptions | undefined, mode: ReadMode): Promise<ReadHit<T>> {
    let sawRetainableValue = false

    for (let index = 0; index < this.layers.length; index += 1) {
      const layer = this.layers[index]
      const stored = await this.readLayerEntry(layer, key)
      if (stored === null) {
        this.incrementMetricMap(this.metrics.missesByLayer, layer.name)
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
      this.incrementMetricMap(this.metrics.hitsByLayer, layer.name)
      this.logger.debug?.('hit', { key, layer: layer.name, state: resolved.state })
      this.emit('hit', { key, layer: layer.name, state: resolved.state })
      return { found: true, value: resolved.value, stored, state: resolved.state, layerIndex: index, layerName: layer.name }
    }

    if (!sawRetainableValue) {
      await this.tagIndex.remove(key)
    }

    this.logger.debug?.('miss', { key, mode })
    this.emit('miss', { key, mode })
    return { found: false, value: null, stored: null, state: 'miss' }
  }

  private async readLayerEntry(layer: CacheLayer, key: string): Promise<unknown | null> {
    if (this.shouldSkipLayer(layer)) {
      return null
    }

    if (layer.getEntry) {
      try {
        return await layer.getEntry(key)
      } catch (error) {
        return this.handleLayerFailure(layer, 'read', error)
      }
    }

    try {
      return await layer.get(key)
    } catch (error) {
      return this.handleLayerFailure(layer, 'read', error)
    }
  }

  private async backfill(key: string, stored: unknown, upToIndex: number, options?: CacheGetOptions): Promise<void> {
    if (upToIndex < 0) {
      return
    }

    for (let index = 0; index <= upToIndex; index += 1) {
      const layer = this.layers[index]
      if (this.shouldSkipLayer(layer)) {
        continue
      }

      const ttl = remainingStoredTtlSeconds(stored) ?? this.resolveLayerSeconds(layer.name, options?.ttl, undefined, layer.defaultTtl)
      try {
        await layer.set(key, stored, ttl)
      } catch (error) {
        await this.handleLayerFailure(layer, 'backfill', error)
        continue
      }
      this.metrics.backfills += 1
      this.logger.debug?.('backfill', { key, layer: layer.name })
      this.emit('backfill', { key, layer: layer.name })
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
      if (this.shouldSkipLayer(layer)) {
        return
      }

      const freshTtl = this.resolveFreshTtl(key, layer.name, kind, options, layer.defaultTtl)
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
      try {
        await layer.set(key, payload, ttl)
      } catch (error) {
        await this.handleLayerFailure(layer, 'write', error)
      }
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
    this.logger.debug?.('write-failure', {
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
    key: string,
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

    const adaptiveTtl = this.applyAdaptiveTtl(
      key,
      layerName,
      baseTtl,
      options?.adaptiveTtl ?? this.options.adaptiveTtl
    )
    const jitter = this.resolveLayerSeconds(layerName, options?.ttlJitter, this.options.ttlJitter)
    return this.applyJitter(adaptiveTtl, jitter)
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
    if (this.isDisconnecting || this.backgroundRefreshes.has(key)) {
      return
    }

    const refresh = (async () => {
      this.metrics.refreshes += 1
      try {
        await this.fetchWithGuards(key, fetcher, options)
      } catch (error) {
        this.metrics.refreshErrors += 1
        this.logger.debug?.('refresh-error', { key, error: this.formatError(error) })
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

    await this.deleteKeysFromLayers(this.layers, keys)

    for (const key of keys) {
      await this.tagIndex.remove(key)
      this.accessProfiles.delete(key)
    }

    this.metrics.deletes += keys.length
    this.metrics.invalidations += 1
    this.logger.debug?.('delete', { keys })
    this.emit('delete', { keys })
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
      this.accessProfiles.clear()
      return
    }

    const keys = message.keys ?? []
    await this.deleteKeysFromLayers(localLayers, keys)

    if (message.operation !== 'write') {
      for (const key of keys) {
        await this.tagIndex.remove(key)
        this.accessProfiles.delete(key)
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

  private shouldBroadcastL1Invalidation(): boolean {
    return this.options.broadcastL1Invalidation ?? this.options.publishSetInvalidation ?? true
  }

  private async deleteKeysFromLayers(layers: CacheLayer[], keys: string[]): Promise<void> {
    await Promise.all(
      layers.map(async (layer) => {
        if (this.shouldSkipLayer(layer)) {
          return
        }

        if (layer.deleteMany) {
          try {
            await layer.deleteMany(keys)
          } catch (error) {
            await this.handleLayerFailure(layer, 'delete', error)
          }
          return
        }

        await Promise.all(keys.map(async (key) => {
          try {
            await layer.delete(key)
          } catch (error) {
            await this.handleLayerFailure(layer, 'delete', error)
          }
        }))
      })
    )
  }

  private validateConfiguration(): void {
    if (
      this.options.broadcastL1Invalidation !== undefined
      && this.options.publishSetInvalidation !== undefined
      && this.options.broadcastL1Invalidation !== this.options.publishSetInvalidation
    ) {
      throw new Error('broadcastL1Invalidation and publishSetInvalidation cannot conflict.')
    }

    if (this.options.stampedePrevention === false && this.options.singleFlightCoordinator) {
      throw new Error('singleFlightCoordinator requires stampedePrevention to remain enabled.')
    }

    this.validateLayerNumberOption('negativeTtl', this.options.negativeTtl)
    this.validateLayerNumberOption('staleWhileRevalidate', this.options.staleWhileRevalidate)
    this.validateLayerNumberOption('staleIfError', this.options.staleIfError)
    this.validateLayerNumberOption('ttlJitter', this.options.ttlJitter)
    this.validateLayerNumberOption('refreshAhead', this.options.refreshAhead)
    this.validatePositiveNumber('singleFlightLeaseMs', this.options.singleFlightLeaseMs)
    this.validatePositiveNumber('singleFlightTimeoutMs', this.options.singleFlightTimeoutMs)
    this.validatePositiveNumber('singleFlightPollMs', this.options.singleFlightPollMs)
    this.validateAdaptiveTtlOptions(this.options.adaptiveTtl)
    this.validateCircuitBreakerOptions(this.options.circuitBreaker)
  }

  private validateWriteOptions(options: CacheWriteOptions | undefined): void {
    if (!options) {
      return
    }

    this.validateLayerNumberOption('options.ttl', options.ttl)
    this.validateLayerNumberOption('options.negativeTtl', options.negativeTtl)
    this.validateLayerNumberOption('options.staleWhileRevalidate', options.staleWhileRevalidate)
    this.validateLayerNumberOption('options.staleIfError', options.staleIfError)
    this.validateLayerNumberOption('options.ttlJitter', options.ttlJitter)
    this.validateLayerNumberOption('options.refreshAhead', options.refreshAhead)
    this.validateAdaptiveTtlOptions(options.adaptiveTtl)
    this.validateCircuitBreakerOptions(options.circuitBreaker)
  }

  private validateLayerNumberOption(name: string, value: number | LayerTtlMap | undefined): void {
    if (value === undefined) {
      return
    }

    if (typeof value === 'number') {
      this.validateNonNegativeNumber(name, value)
      return
    }

    for (const [layerName, layerValue] of Object.entries(value)) {
      if (layerValue === undefined) {
        continue
      }

      this.validateNonNegativeNumber(`${name}.${layerName}`, layerValue)
    }
  }

  private validatePositiveNumber(name: string, value: number | undefined): void {
    if (value === undefined) {
      return
    }

    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`${name} must be a positive finite number.`)
    }
  }

  private validateNonNegativeNumber(name: string, value: number): void {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`${name} must be a non-negative finite number.`)
    }
  }

  private validateCacheKey(key: string): string {
    if (key.length === 0) {
      throw new Error('Cache key must not be empty.')
    }

    if (key.length > MAX_CACHE_KEY_LENGTH) {
      throw new Error(`Cache key length must be at most ${MAX_CACHE_KEY_LENGTH} characters.`)
    }

    if (/[\u0000-\u001F\u007F]/.test(key)) {
      throw new Error('Cache key contains unsupported control characters.')
    }

    return key
  }

  private serializeOptions(options: CacheGetOptions | undefined): string {
    return JSON.stringify(this.normalizeForSerialization(options) ?? null)
  }

  private validateAdaptiveTtlOptions(options: boolean | CacheAdaptiveTtlOptions | undefined): void {
    if (!options || options === true) {
      return
    }

    this.validatePositiveNumber('adaptiveTtl.hotAfter', options.hotAfter)
    this.validateLayerNumberOption('adaptiveTtl.step', options.step)
    this.validateLayerNumberOption('adaptiveTtl.maxTtl', options.maxTtl)
  }

  private validateCircuitBreakerOptions(options: CacheCircuitBreakerOptions | undefined): void {
    if (!options) {
      return
    }

    this.validatePositiveNumber('circuitBreaker.failureThreshold', options.failureThreshold)
    this.validatePositiveNumber('circuitBreaker.cooldownMs', options.cooldownMs)
  }

  private async applyFreshReadPolicies<T>(
    key: string,
    hit: Extract<ReadHit<T>, { found: true }>,
    options: CacheGetOptions | undefined,
    fetcher?: () => Promise<T>
  ): Promise<void> {
    const refreshAhead = this.resolveLayerSeconds(hit.layerName, options?.refreshAhead, this.options.refreshAhead, 0) ?? 0
    const remainingFreshTtl = remainingFreshTtlSeconds(hit.stored) ?? 0

    if ((options?.slidingTtl ?? false) && isStoredValueEnvelope(hit.stored)) {
      const refreshed = refreshStoredEnvelope(hit.stored)
      const ttl = remainingStoredTtlSeconds(refreshed)
      for (let index = 0; index <= hit.layerIndex; index += 1) {
        const layer = this.layers[index]
        if (this.shouldSkipLayer(layer)) {
          continue
        }

        try {
          await layer.set(key, refreshed, ttl)
        } catch (error) {
          await this.handleLayerFailure(layer, 'sliding-ttl', error)
        }
      }
    }

    if (fetcher && refreshAhead > 0 && remainingFreshTtl > 0 && remainingFreshTtl <= refreshAhead) {
      this.scheduleBackgroundRefresh(key, fetcher, options)
    }
  }

  private applyAdaptiveTtl(
    key: string,
    layerName: string,
    ttl: number | undefined,
    adaptiveTtl: boolean | CacheAdaptiveTtlOptions | undefined
  ): number | undefined {
    if (!ttl || !adaptiveTtl) {
      return ttl
    }

    const profile = this.accessProfiles.get(key)
    if (!profile) {
      return ttl
    }

    const config = adaptiveTtl === true ? {} : adaptiveTtl
    const hotAfter = config.hotAfter ?? 3
    if (profile.hits < hotAfter) {
      return ttl
    }

    const step = this.resolveLayerSeconds(layerName, config.step, undefined, Math.max(1, Math.round(ttl / 2))) ?? 0
    const maxTtl = this.resolveLayerSeconds(layerName, config.maxTtl, undefined, ttl + step * 4) ?? ttl
    const multiplier = Math.floor(profile.hits / hotAfter)
    return Math.min(maxTtl, ttl + step * multiplier)
  }

  private recordAccess(key: string): void {
    const profile = this.accessProfiles.get(key) ?? { hits: 0, lastAccessAt: Date.now() }
    profile.hits += 1
    profile.lastAccessAt = Date.now()
    this.accessProfiles.set(key, profile)
  }

  private incrementMetricMap(target: Record<string, number>, key: string): void {
    target[key] = (target[key] ?? 0) + 1
  }

  private shouldSkipLayer(layer: CacheLayer): boolean {
    const degradedUntil = this.layerDegradedUntil.get(layer.name)
    return degradedUntil !== undefined && degradedUntil > Date.now()
  }

  private async handleLayerFailure(layer: CacheLayer, operation: string, error: unknown): Promise<null> {
    if (!this.isGracefulDegradationEnabled()) {
      throw error
    }

    const retryAfterMs = typeof this.options.gracefulDegradation === 'object'
      ? this.options.gracefulDegradation.retryAfterMs ?? 10_000
      : 10_000

    this.layerDegradedUntil.set(layer.name, Date.now() + retryAfterMs)
    this.metrics.degradedOperations += 1
    this.logger.warn?.('layer-degraded', { layer: layer.name, operation, error: this.formatError(error) })
    this.emitError(operation, { layer: layer.name, degraded: true, error: this.formatError(error) })
    return null
  }

  private isGracefulDegradationEnabled(): boolean {
    return Boolean(this.options.gracefulDegradation)
  }

  private assertCircuitClosed(key: string, options: CacheCircuitBreakerOptions | undefined): void {
    const state = this.circuitBreakers.get(key)
    if (!state?.openUntil) {
      return
    }

    if (state.openUntil <= Date.now()) {
      state.openUntil = null
      state.failures = 0
      this.circuitBreakers.set(key, state)
      return
    }

    this.emitError('circuit-breaker-open', { key, openUntil: state.openUntil })
    throw new Error(`Circuit breaker is open for key "${key}".`)
  }

  private recordCircuitFailure(key: string, options: CacheCircuitBreakerOptions | undefined, error: unknown): void {
    if (!options) {
      return
    }

    const failureThreshold = options.failureThreshold ?? 3
    const cooldownMs = options.cooldownMs ?? 30_000
    const state = this.circuitBreakers.get(key) ?? { failures: 0, openUntil: null }
    state.failures += 1

    if (state.failures >= failureThreshold) {
      state.openUntil = Date.now() + cooldownMs
      this.metrics.circuitBreakerTrips += 1
    }

    this.circuitBreakers.set(key, state)
    this.emitError('fetch', { key, error: this.formatError(error), failures: state.failures })
  }

  private resetCircuitBreaker(key: string): void {
    this.circuitBreakers.delete(key)
  }

  private isNegativeStoredValue(stored: unknown): boolean {
    return isStoredValueEnvelope(stored) && stored.kind === 'empty'
  }

  private emitError(operation: string, context: Record<string, unknown>): void {
    this.logger.error?.(operation, context)
    if (this.listenerCount('error') > 0) {
      this.emit('error', { operation, ...context })
    }
  }

  private serializeKeyPart(value: unknown): string {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      return String(value)
    }

    return JSON.stringify(this.normalizeForSerialization(value))
  }

  private isCacheSnapshotEntries(value: unknown): value is CacheSnapshotEntry[] {
    return Array.isArray(value) && value.every((entry) => {
      if (!entry || typeof entry !== 'object') {
        return false
      }

      const candidate = entry as Partial<CacheSnapshotEntry>
      return typeof candidate.key === 'string'
    })
  }

  private normalizeForSerialization(value: unknown): unknown {
    if (Array.isArray(value)) {
      return value.map((entry) => this.normalizeForSerialization(entry))
    }

    if (value && typeof value === 'object') {
      return Object.keys(value as Record<string, unknown>)
        .sort()
        .reduce<Record<string, unknown>>((normalized, key) => {
          normalized[key] = this.normalizeForSerialization((value as Record<string, unknown>)[key])
          return normalized
        }, {})
    }

    return value
  }
}
