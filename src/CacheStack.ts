import { EventEmitter } from 'node:events'
import { CacheNamespace } from './CacheNamespace'
import { CircuitBreakerManager } from './internal/CircuitBreakerManager'
import { FetchRateLimiter } from './internal/FetchRateLimiter'
import { MetricsCollector } from './internal/MetricsCollector'
import {
  createStoredValueEnvelope,
  isStoredValueEnvelope,
  refreshStoredEnvelope,
  remainingFreshTtlSeconds,
  remainingStoredTtlSeconds,
  resolveStoredValue
} from './internal/StoredValue'
import { TtlResolver } from './internal/TtlResolver'
import { TagIndex } from './invalidation/TagIndex'
import { StampedeGuard } from './stampede/StampedeGuard'
import {
  type CacheAdaptiveTtlOptions,
  type CacheCircuitBreakerOptions,
  type CacheGetOptions,
  type CacheHealthCheckResult,
  type CacheHitRateSnapshot,
  type CacheInspectResult,
  type CacheLayer,
  type CacheLayerSetManyEntry,
  type CacheLogger,
  type CacheMGetEntry,
  type CacheMSetEntry,
  type CacheMetricsSnapshot,
  CacheMissError,
  type CacheSingleFlightExecutionOptions,
  type CacheSnapshotEntry,
  type CacheStackEvents,
  type CacheStackOptions,
  type CacheStatsSnapshot,
  type CacheTagIndex,
  type CacheTtlPolicy,
  type CacheWarmEntry,
  type CacheWarmOptions,
  type CacheWarmProgress,
  type CacheWrapOptions,
  type CacheWriteBehindOptions,
  type CacheWriteOptions,
  type InvalidationMessage,
  type LayerTtlMap
} from './types'

const DEFAULT_SINGLE_FLIGHT_LEASE_MS = 30_000
const DEFAULT_SINGLE_FLIGHT_TIMEOUT_MS = 5_000
const DEFAULT_SINGLE_FLIGHT_POLL_MS = 50
const MAX_CACHE_KEY_LENGTH = 1_024
const DEFAULT_MAX_PROFILE_ENTRIES = 100_000

type ReadMode = 'allow-stale' | 'fresh-only'
type CacheWriteKind = 'value' | 'empty'

type ReadHit<T> =
  | {
      found: true
      value: T | null
      stored: unknown
      state: 'fresh' | 'stale-while-revalidate' | 'stale-if-error'
      layerIndex: number
      layerName: string
    }
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

/** Typed overloads for EventEmitter so callers get autocomplete on event names. */
export interface CacheStack {
  on<K extends keyof CacheStackEvents>(event: K, listener: (data: CacheStackEvents[K]) => void): this
  once<K extends keyof CacheStackEvents>(event: K, listener: (data: CacheStackEvents[K]) => void): this
  off<K extends keyof CacheStackEvents>(event: K, listener: (data: CacheStackEvents[K]) => void): this
  removeAllListeners<K extends keyof CacheStackEvents>(event?: K): this
  listeners<K extends keyof CacheStackEvents>(event: K): Array<(data: CacheStackEvents[K]) => void>
  listenerCount<K extends keyof CacheStackEvents>(event: K): number
  emit<K extends keyof CacheStackEvents>(event: K, data: CacheStackEvents[K]): boolean
}

export class CacheStack extends EventEmitter {
  private readonly stampedeGuard = new StampedeGuard()
  private readonly metricsCollector = new MetricsCollector()
  private readonly instanceId = createInstanceId()
  private readonly startup: Promise<void>
  private unsubscribeInvalidation?: () => Promise<void> | void
  private readonly logger: CacheLogger
  private readonly tagIndex: CacheTagIndex
  private readonly fetchRateLimiter = new FetchRateLimiter()
  private readonly backgroundRefreshes = new Map<string, Promise<void>>()
  private readonly layerDegradedUntil = new Map<string, number>()
  private readonly ttlResolver: TtlResolver
  private readonly circuitBreakerManager: CircuitBreakerManager
  private currentGeneration?: number
  private readonly writeBehindQueue: Array<() => Promise<void>> = []
  private writeBehindTimer?: ReturnType<typeof setInterval>
  private writeBehindFlushPromise?: Promise<void>
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

    const maxProfileEntries = options.maxProfileEntries ?? DEFAULT_MAX_PROFILE_ENTRIES
    this.ttlResolver = new TtlResolver({ maxProfileEntries })
    this.circuitBreakerManager = new CircuitBreakerManager({ maxEntries: maxProfileEntries })
    this.currentGeneration = options.generation

    if (options.publishSetInvalidation !== undefined) {
      console.warn(
        '[layercache] CacheStackOptions.publishSetInvalidation is deprecated. ' + 'Use broadcastL1Invalidation instead.'
      )
    }

    const debugEnv = process.env.DEBUG?.split(',').includes('layercache:debug') ?? false
    this.logger =
      typeof options.logger === 'object' ? options.logger : new DebugLogger(Boolean(options.logger) || debugEnv)
    this.tagIndex = options.tagIndex ?? new TagIndex()
    this.initializeWriteBehind(options.writeBehind)
    this.startup = this.initialize()
  }

  /**
   * Read-through cache get.
   * Returns the cached value if present and fresh, or invokes `fetcher` on a miss
   * and stores the result across all layers. Returns `null` if the key is not found
   * and no `fetcher` is provided.
   */
  async get<T>(key: string, fetcher?: () => Promise<T>, options?: CacheGetOptions): Promise<T | null> {
    this.assertActive('get')
    const normalizedKey = this.qualifyKey(this.validateCacheKey(key))
    this.validateWriteOptions(options)
    await this.startup
    this.assertActive('get')

    const hit = await this.readFromLayers<T>(normalizedKey, options, 'allow-stale')
    if (hit.found) {
      this.ttlResolver.recordAccess(normalizedKey)
      if (this.isNegativeStoredValue(hit.stored)) {
        this.metricsCollector.increment('negativeCacheHits')
      }

      if (hit.state === 'fresh') {
        this.metricsCollector.increment('hits')
        await this.applyFreshReadPolicies(normalizedKey, hit, options, fetcher)
        return hit.value
      }

      if (hit.state === 'stale-while-revalidate') {
        this.metricsCollector.increment('hits')
        this.metricsCollector.increment('staleHits')
        this.emit('stale-serve', { key: normalizedKey, state: hit.state, layer: hit.layerName })
        if (fetcher) {
          this.scheduleBackgroundRefresh(normalizedKey, fetcher, options)
        }
        return hit.value
      }

      if (!fetcher) {
        this.metricsCollector.increment('hits')
        this.metricsCollector.increment('staleHits')
        this.emit('stale-serve', { key: normalizedKey, state: hit.state, layer: hit.layerName })
        return hit.value
      }

      try {
        return await this.fetchWithGuards(normalizedKey, fetcher, options)
      } catch (error) {
        this.metricsCollector.increment('staleHits')
        this.metricsCollector.increment('refreshErrors')
        this.logger.debug?.('stale-if-error', { key: normalizedKey, error: this.formatError(error) })
        return hit.value
      }
    }

    this.metricsCollector.increment('misses')
    if (!fetcher) {
      return null
    }

    return this.fetchWithGuards(normalizedKey, fetcher, options)
  }

  /**
   * Alias for `get(key, fetcher, options)` — explicit get-or-set pattern.
   * Fetches and caches the value if not already present.
   */
  async getOrSet<T>(key: string, fetcher: () => Promise<T>, options?: CacheGetOptions): Promise<T | null> {
    return this.get(key, fetcher, options)
  }

  /**
   * Like `get()`, but throws `CacheMissError` instead of returning `null`.
   * Useful when the value is expected to exist or the fetcher is expected to
   * return non-null.
   */
  async getOrThrow<T>(key: string, fetcher?: () => Promise<T>, options?: CacheGetOptions): Promise<T> {
    const value = await this.get(key, fetcher, options)
    if (value === null) {
      throw new CacheMissError(key)
    }
    return value
  }

  /**
   * Returns true if the given key exists and is not expired in any layer.
   */
  async has(key: string): Promise<boolean> {
    this.assertActive('has')
    const normalizedKey = this.qualifyKey(this.validateCacheKey(key))
    await this.startup
    this.assertActive('has')

    for (const layer of this.layers) {
      if (this.shouldSkipLayer(layer)) {
        continue
      }
      if (layer.has) {
        try {
          const exists = await layer.has(normalizedKey)
          if (exists) {
            return true
          }
        } catch {
          // fall through to next layer
        }
      } else {
        try {
          const value = await layer.get(normalizedKey)
          if (value !== null) {
            return true
          }
        } catch {
          // fall through
        }
      }
    }
    return false
  }

  /**
   * Returns the remaining TTL in seconds for the key in the fastest layer
   * that has it, or null if the key is not found / has no TTL.
   */
  async ttl(key: string): Promise<number | null> {
    this.assertActive('ttl')
    const normalizedKey = this.qualifyKey(this.validateCacheKey(key))
    await this.startup
    this.assertActive('ttl')

    for (const layer of this.layers) {
      if (this.shouldSkipLayer(layer)) {
        continue
      }
      if (layer.ttl) {
        try {
          const remaining = await layer.ttl(normalizedKey)
          if (remaining !== null) {
            return remaining
          }
        } catch {
          // fall through
        }
      }
    }
    return null
  }

  /**
   * Stores a value in all cache layers. Overwrites any existing value.
   */
  async set<T>(key: string, value: T, options?: CacheWriteOptions): Promise<void> {
    this.assertActive('set')
    const normalizedKey = this.qualifyKey(this.validateCacheKey(key))
    this.validateWriteOptions(options)
    await this.startup
    this.assertActive('set')
    await this.storeEntry(normalizedKey, 'value', value, options)
  }

  /**
   * Deletes the key from all layers and publishes an invalidation message.
   */
  async delete(key: string): Promise<void> {
    this.assertActive('delete')
    const normalizedKey = this.qualifyKey(this.validateCacheKey(key))
    await this.startup
    this.assertActive('delete')
    await this.deleteKeys([normalizedKey])
    await this.publishInvalidation({
      scope: 'key',
      keys: [normalizedKey],
      sourceId: this.instanceId,
      operation: 'delete'
    })
  }

  async clear(): Promise<void> {
    this.assertActive('clear')
    await this.startup
    this.assertActive('clear')
    await Promise.all(this.layers.map((layer) => layer.clear()))
    await this.tagIndex.clear()
    this.ttlResolver.clearProfiles()
    this.circuitBreakerManager.clear()
    this.metricsCollector.increment('invalidations')
    this.logger.debug?.('clear')
    await this.publishInvalidation({ scope: 'clear', sourceId: this.instanceId, operation: 'clear' })
  }

  /**
   * Deletes multiple keys at once. More efficient than calling `delete()` in a loop.
   */
  async mdelete(keys: string[]): Promise<void> {
    this.assertActive('mdelete')
    if (keys.length === 0) {
      return
    }
    await this.startup
    this.assertActive('mdelete')
    const normalizedKeys = keys.map((k) => this.validateCacheKey(k))
    const cacheKeys = normalizedKeys.map((key) => this.qualifyKey(key))
    await this.deleteKeys(cacheKeys)
    await this.publishInvalidation({
      scope: 'keys',
      keys: cacheKeys,
      sourceId: this.instanceId,
      operation: 'delete'
    })
  }

  async mget<T>(entries: CacheMGetEntry<T>[]): Promise<Array<T | null>> {
    this.assertActive('mget')
    if (entries.length === 0) {
      return []
    }

    const normalizedEntries = entries.map((entry) => ({
      ...entry,
      key: this.qualifyKey(this.validateCacheKey(entry.key))
    }))
    normalizedEntries.forEach((entry) => this.validateWriteOptions(entry.options))
    const canFastPath = normalizedEntries.every((entry) => entry.fetch === undefined && entry.options === undefined)
    if (!canFastPath) {
      const pendingReads = new Map<
        string,
        {
          promise: Promise<T | null>
          fetch?: () => Promise<T>
          optionsSignature: string
        }
      >()

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
    this.assertActive('mget')
    const pending = new Set<string>()
    const indexesByKey = new Map<string, number[]>()
    const resultsByKey = new Map<string, T | null>()

    for (let index = 0; index < normalizedEntries.length; index += 1) {
      const entry = normalizedEntries[index]
      if (!entry) continue
      const key = entry.key
      const indexes = indexesByKey.get(key) ?? []
      indexes.push(index)
      indexesByKey.set(key, indexes)
      pending.add(key)
    }

    for (let layerIndex = 0; layerIndex < this.layers.length; layerIndex += 1) {
      const layer = this.layers[layerIndex]
      if (!layer) continue
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
        if (!key || stored === null) {
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
        this.metricsCollector.increment('hits', indexesByKey.get(key)?.length ?? 1)
      }
    }

    if (pending.size > 0) {
      for (const key of pending) {
        await this.tagIndex.remove(key)
        this.metricsCollector.increment('misses', indexesByKey.get(key)?.length ?? 1)
      }
    }

    return normalizedEntries.map((entry) => resultsByKey.get(entry.key) ?? null)
  }

  async mset<T>(entries: CacheMSetEntry<T>[]): Promise<void> {
    this.assertActive('mset')
    const normalizedEntries = entries.map((entry) => ({
      ...entry,
      key: this.qualifyKey(this.validateCacheKey(entry.key))
    }))
    normalizedEntries.forEach((entry) => this.validateWriteOptions(entry.options))
    await this.startup
    this.assertActive('mset')
    await this.writeBatch(normalizedEntries)
  }

  async warm(entries: CacheWarmEntry[], options: CacheWarmOptions = {}): Promise<void> {
    this.assertActive('warm')
    const concurrency = Math.max(1, options.concurrency ?? 4)
    const total = entries.length
    let completed = 0
    const queue = [...entries].sort((left, right) => (right.priority ?? 0) - (left.priority ?? 0))
    const workers = Array.from({ length: Math.min(concurrency, queue.length || 1) }, async () => {
      while (queue.length > 0) {
        const entry = queue.shift()
        if (!entry) {
          return
        }

        let success = false
        try {
          await this.get(entry.key, entry.fetcher, entry.options)
          this.emit('warm', { key: entry.key })
          success = true
        } catch (error) {
          this.emitError('warm', { key: entry.key, error: this.formatError(error) })
          if (!options.continueOnError) {
            throw error
          }
        } finally {
          completed += 1
          const progress: CacheWarmProgress = { completed, total, key: entry.key, success }
          options.onProgress?.(progress)
        }
      }
    })

    await Promise.all(workers)
  }

  /**
   * Returns a cached version of `fetcher`. The cache key is derived from
   * `prefix` plus the serialized arguments unless a `keyResolver` is provided.
   */
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

  /**
   * Creates a `CacheNamespace` that automatically prefixes all keys with
   * `prefix:`. Useful for multi-tenant or module-level isolation.
   */
  namespace(prefix: string): CacheNamespace {
    return new CacheNamespace(this, prefix)
  }

  async invalidateByTag(tag: string): Promise<void> {
    this.assertActive('invalidateByTag')
    await this.startup
    this.assertActive('invalidateByTag')
    const keys = await this.tagIndex.keysForTag(tag)
    await this.deleteKeys(keys)
    await this.publishInvalidation({ scope: 'keys', keys, sourceId: this.instanceId, operation: 'invalidate' })
  }

  async invalidateByTags(tags: string[], mode: 'any' | 'all' = 'any'): Promise<void> {
    this.assertActive('invalidateByTags')
    if (tags.length === 0) {
      return
    }

    await this.startup
    this.assertActive('invalidateByTags')
    const keysByTag = await Promise.all(tags.map((tag) => this.tagIndex.keysForTag(tag)))
    const keys =
      mode === 'all'
        ? this.intersectKeys(keysByTag)
        : [...new Set(keysByTag.flatMap((entries) => entries))]

    await this.deleteKeys(keys)
    await this.publishInvalidation({ scope: 'keys', keys, sourceId: this.instanceId, operation: 'invalidate' })
  }

  async invalidateByPattern(pattern: string): Promise<void> {
    this.assertActive('invalidateByPattern')
    await this.startup
    this.assertActive('invalidateByPattern')
    const keys = await this.tagIndex.matchPattern(this.qualifyPattern(pattern))
    await this.deleteKeys(keys)
    await this.publishInvalidation({ scope: 'keys', keys, sourceId: this.instanceId, operation: 'invalidate' })
  }

  async invalidateByPrefix(prefix: string): Promise<void> {
    this.assertActive('invalidateByPrefix')
    await this.startup
    this.assertActive('invalidateByPrefix')
    const qualifiedPrefix = this.qualifyKey(this.validateCacheKey(prefix))
    const keys = this.tagIndex.keysForPrefix
      ? await this.tagIndex.keysForPrefix(qualifiedPrefix)
      : await this.tagIndex.matchPattern(`${qualifiedPrefix}*`)
    await this.deleteKeys(keys)
    await this.publishInvalidation({ scope: 'keys', keys, sourceId: this.instanceId, operation: 'invalidate' })
  }

  getMetrics(): CacheMetricsSnapshot {
    return this.metricsCollector.snapshot
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
    this.metricsCollector.reset()
  }

  /**
   * Returns computed hit-rate statistics (overall and per-layer).
   */
  getHitRate(): CacheHitRateSnapshot {
    return this.metricsCollector.hitRate()
  }

  async healthCheck(): Promise<CacheHealthCheckResult[]> {
    await this.startup

    return Promise.all(
      this.layers.map(async (layer) => {
        const startedAt = performance.now()
        try {
          const healthy = layer.ping ? await layer.ping() : true
          return {
            layer: layer.name,
            healthy,
            latencyMs: performance.now() - startedAt
          }
        } catch (error) {
          return {
            layer: layer.name,
            healthy: false,
            latencyMs: performance.now() - startedAt,
            error: this.formatError(error)
          }
        }
      })
    )
  }

  bumpGeneration(nextGeneration?: number): number {
    const current = this.currentGeneration ?? 0
    this.currentGeneration = nextGeneration ?? current + 1
    return this.currentGeneration
  }

  /**
   * Returns detailed metadata about a single cache key: which layers contain it,
   * remaining fresh/stale/error TTLs, and associated tags.
   * Returns `null` if the key does not exist in any layer.
   */
  async inspect(key: string): Promise<CacheInspectResult | null> {
    this.assertActive('inspect')
    const userKey = this.validateCacheKey(key)
    const normalizedKey = this.qualifyKey(userKey)
    await this.startup
    this.assertActive('inspect')

    const foundInLayers: string[] = []
    let freshTtlSeconds: number | null = null
    let staleTtlSeconds: number | null = null
    let errorTtlSeconds: number | null = null
    let isStale = false

    for (const layer of this.layers) {
      if (this.shouldSkipLayer(layer)) {
        continue
      }
      const stored = await this.readLayerEntry(layer, normalizedKey)
      if (stored === null) {
        continue
      }

      const resolved = resolveStoredValue(stored)
      if (resolved.state === 'expired') {
        continue
      }

      foundInLayers.push(layer.name)

      // Take TTL info from the first (fastest) layer that has it
      if (foundInLayers.length === 1 && resolved.envelope) {
        const now = Date.now()
        freshTtlSeconds =
          resolved.envelope.freshUntil !== null
            ? Math.max(0, Math.ceil((resolved.envelope.freshUntil - now) / 1_000))
            : null
        staleTtlSeconds =
          resolved.envelope.staleUntil !== null
            ? Math.max(0, Math.ceil((resolved.envelope.staleUntil - now) / 1_000))
            : null
        errorTtlSeconds =
          resolved.envelope.errorUntil !== null
            ? Math.max(0, Math.ceil((resolved.envelope.errorUntil - now) / 1_000))
            : null
        isStale = resolved.state === 'stale-while-revalidate' || resolved.state === 'stale-if-error'
      }
    }

    if (foundInLayers.length === 0) {
      return null
    }

    const tags = await this.getTagsForKey(normalizedKey)

    return { key: userKey, foundInLayers, freshTtlSeconds, staleTtlSeconds, errorTtlSeconds, isStale, tags }
  }

  async exportState(): Promise<CacheSnapshotEntry[]> {
    this.assertActive('exportState')
    await this.startup
    this.assertActive('exportState')
    const exported = new Map<string, CacheSnapshotEntry>()

    for (const layer of this.layers) {
      if (!layer.keys) {
        continue
      }

      const keys = await layer.keys()
      for (const key of keys) {
        const exportedKey = this.stripQualifiedKey(key)
        if (exported.has(exportedKey)) {
          continue
        }

        const stored = await this.readLayerEntry(layer, key)
        if (stored === null) {
          continue
        }

        exported.set(exportedKey, {
          key: exportedKey,
          value: stored,
          ttl: remainingStoredTtlSeconds(stored)
        })
      }
    }

    return [...exported.values()]
  }

  async importState(entries: CacheSnapshotEntry[]): Promise<void> {
    this.assertActive('importState')
    await this.startup
    this.assertActive('importState')
    await Promise.all(
      entries.map(async (entry) => {
        const qualifiedKey = this.qualifyKey(entry.key)
        await Promise.all(this.layers.map((layer) => layer.set(qualifiedKey, entry.value, entry.ttl)))
        await this.tagIndex.touch(qualifiedKey)
      })
    )
  }

  async persistToFile(filePath: string): Promise<void> {
    this.assertActive('persistToFile')
    const snapshot = await this.exportState()
    const { promises: fs } = await import('node:fs')
    await fs.writeFile(filePath, JSON.stringify(snapshot, null, 2), 'utf8')
  }

  async restoreFromFile(filePath: string): Promise<void> {
    this.assertActive('restoreFromFile')
    const { promises: fs } = await import('node:fs')
    const raw = await fs.readFile(filePath, 'utf8')
    let parsed: unknown
    try {
      // Use Object.create(null) as reviver base to prevent __proto__ pollution
      parsed = JSON.parse(raw, (_key, value: unknown) => {
        if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
          return Object.assign(Object.create(null) as Record<string, unknown>, value)
        }
        return value
      })
    } catch (cause) {
      throw new Error(`Invalid snapshot file: could not parse JSON (${this.formatError(cause)})`)
    }
    if (!this.isCacheSnapshotEntries(parsed)) {
      throw new Error('Invalid snapshot file: expected an array of { key: string, value, ttl? } entries')
    }
    await this.importState(parsed)
  }

  async disconnect(): Promise<void> {
    if (!this.disconnectPromise) {
      this.isDisconnecting = true
      this.disconnectPromise = (async () => {
        await this.startup
        await this.unsubscribeInvalidation?.()
        await this.flushWriteBehindQueue()
        await Promise.allSettled([...this.backgroundRefreshes.values()])
        if (this.writeBehindTimer) {
          clearInterval(this.writeBehindTimer)
          this.writeBehindTimer = undefined
        }
        await Promise.allSettled(this.layers.map((layer) => layer.dispose?.() ?? Promise.resolve()))
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

  private async fetchWithGuards<T>(
    key: string,
    fetcher: () => Promise<T>,
    options?: CacheGetOptions
  ): Promise<T | null> {
    const fetchTask = async (): Promise<T | null> => {
      const secondHit = await this.readFromLayers<T>(key, options, 'fresh-only')
      if (secondHit.found) {
        this.metricsCollector.increment('hits')
        return secondHit.value
      }

      return this.fetchAndPopulate(key, fetcher, options)
    }

    const singleFlightTask = async (): Promise<T | null> => {
      if (!this.options.singleFlightCoordinator) {
        return fetchTask()
      }

      return this.options.singleFlightCoordinator.execute(key, this.resolveSingleFlightOptions(), fetchTask, () =>
        this.waitForFreshValue(key, fetcher, options)
      )
    }

    if (this.options.stampedePrevention === false) {
      return singleFlightTask()
    }

    return this.stampedeGuard.execute(key, singleFlightTask)
  }

  private async waitForFreshValue<T>(
    key: string,
    fetcher: () => Promise<T>,
    options?: CacheGetOptions
  ): Promise<T | null> {
    const timeoutMs = this.options.singleFlightTimeoutMs ?? DEFAULT_SINGLE_FLIGHT_TIMEOUT_MS
    const pollIntervalMs = this.options.singleFlightPollMs ?? DEFAULT_SINGLE_FLIGHT_POLL_MS
    const deadline = Date.now() + timeoutMs

    this.metricsCollector.increment('singleFlightWaits')
    this.emit('stampede-dedupe', { key })

    while (Date.now() < deadline) {
      const hit = await this.readFromLayers<T>(key, options, 'fresh-only')
      if (hit.found) {
        this.metricsCollector.increment('hits')
        return hit.value
      }
      await this.sleep(pollIntervalMs)
    }

    return this.fetchAndPopulate(key, fetcher, options)
  }

  private async fetchAndPopulate<T>(
    key: string,
    fetcher: () => Promise<T>,
    options?: CacheGetOptions
  ): Promise<T | null> {
    this.circuitBreakerManager.assertClosed(key, options?.circuitBreaker ?? this.options.circuitBreaker)
    this.metricsCollector.increment('fetches')
    const fetchStart = Date.now()
    let fetched: T

    try {
      fetched = await this.fetchRateLimiter.schedule(options?.fetcherRateLimit ?? this.options.fetcherRateLimit, fetcher)
      this.circuitBreakerManager.recordSuccess(key)
      this.logger.debug?.('fetch', { key, durationMs: Date.now() - fetchStart })
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

    // Conditional caching: skip storage if shouldCache returns false
    if (options?.shouldCache && !options.shouldCache(fetched)) {
      return fetched
    }

    await this.storeEntry(key, 'value', fetched, options)
    return fetched
  }

  private async storeEntry(
    key: string,
    kind: CacheWriteKind,
    value: unknown,
    options?: CacheWriteOptions
  ): Promise<void> {
    await this.writeAcrossLayers(key, kind, value, options)
    if (options?.tags) {
      await this.tagIndex.track(key, options.tags)
    } else {
      await this.tagIndex.touch(key)
    }

    this.metricsCollector.increment('sets')
    this.logger.debug?.('set', { key, kind, tags: options?.tags })
    this.emit('set', { key, kind: kind as string, tags: options?.tags })
    if (this.shouldBroadcastL1Invalidation()) {
      await this.publishInvalidation({ scope: 'key', keys: [key], sourceId: this.instanceId, operation: 'write' })
    }
  }

  private async writeBatch(entries: Array<{ key: string; value: unknown; options?: CacheWriteOptions }>): Promise<void> {
    const now = Date.now()
    const entriesByLayer = new Map<CacheLayer, CacheLayerSetManyEntry[]>()
    const immediateOperations: Array<() => Promise<void>> = []
    const deferredOperations: Array<() => Promise<void>> = []

    for (const entry of entries) {
      for (const layer of this.layers) {
        if (this.shouldSkipLayer(layer)) {
          continue
        }

        const layerEntry = this.buildLayerSetEntry(layer, entry.key, 'value', entry.value, entry.options, now)
        const bucket = entriesByLayer.get(layer) ?? []
        bucket.push(layerEntry)
        entriesByLayer.set(layer, bucket)
      }
    }

    for (const [layer, layerEntries] of entriesByLayer.entries()) {
      const operation = async () => {
        try {
          if (layer.setMany) {
            await layer.setMany(layerEntries)
            return
          }

          await Promise.all(layerEntries.map((entry) => layer.set(entry.key, entry.value, entry.ttl)))
        } catch (error) {
          await this.handleLayerFailure(layer, 'write', error)
        }
      }

      if (this.shouldWriteBehind(layer)) {
        deferredOperations.push(operation)
      } else {
        immediateOperations.push(operation)
      }
    }

    await this.executeLayerOperations(immediateOperations, { key: 'batch', action: 'mset' })
    deferredOperations.forEach((operation) => this.enqueueWriteBehind(operation))

    for (const entry of entries) {
      if (entry.options?.tags) {
        await this.tagIndex.track(entry.key, entry.options.tags)
      } else {
        await this.tagIndex.touch(entry.key)
      }

      this.metricsCollector.increment('sets')
      this.logger.debug?.('set', { key: entry.key, kind: 'value', tags: entry.options?.tags })
      this.emit('set', { key: entry.key, kind: 'value', tags: entry.options?.tags })
    }

    if (this.shouldBroadcastL1Invalidation()) {
      await this.publishInvalidation({
        scope: 'keys',
        keys: entries.map((entry) => entry.key),
        sourceId: this.instanceId,
        operation: 'write'
      })
    }
  }

  private async readFromLayers<T>(
    key: string,
    options: CacheGetOptions | undefined,
    mode: ReadMode
  ): Promise<ReadHit<T>> {
    let sawRetainableValue = false

    for (let index = 0; index < this.layers.length; index += 1) {
      const layer = this.layers[index]
      if (!layer) continue
      const readStart = performance.now()
      const stored = await this.readLayerEntry(layer, key)
      const readDuration = performance.now() - readStart
      this.metricsCollector.recordLatency(layer.name, readDuration)
      if (stored === null) {
        this.metricsCollector.incrementLayer('missesByLayer', layer.name)
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
      this.metricsCollector.incrementLayer('hitsByLayer', layer.name)
      this.logger.debug?.('hit', { key, layer: layer.name, state: resolved.state })
      this.emit('hit', { key, layer: layer.name, state: resolved.state as CacheStackEvents['hit']['state'] })
      return {
        found: true,
        value: resolved.value,
        stored,
        state: resolved.state,
        layerIndex: index,
        layerName: layer.name
      }
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
      if (!layer || this.shouldSkipLayer(layer)) {
        continue
      }

      const ttl =
        remainingStoredTtlSeconds(stored) ??
        this.resolveLayerSeconds(layer.name, options?.ttl, undefined, layer.defaultTtl)
      try {
        await layer.set(key, stored, ttl)
      } catch (error) {
        await this.handleLayerFailure(layer, 'backfill', error)
        continue
      }
      this.metricsCollector.increment('backfills')
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
    const immediateOperations: Array<() => Promise<void>> = []
    const deferredOperations: Array<() => Promise<void>> = []

    for (const layer of this.layers) {
      const operation = async () => {
        if (this.shouldSkipLayer(layer)) {
          return
        }

        const entry = this.buildLayerSetEntry(layer, key, kind, value, options, now)
        try {
          await layer.set(entry.key, entry.value, entry.ttl)
        } catch (error) {
          await this.handleLayerFailure(layer, 'write', error)
        }
      }

      if (this.shouldWriteBehind(layer)) {
        deferredOperations.push(operation)
      } else {
        immediateOperations.push(operation)
      }
    }

    await this.executeLayerOperations(immediateOperations, { key, action: kind === 'empty' ? 'negative-set' : 'set' })
    deferredOperations.forEach((operation) => this.enqueueWriteBehind(operation))
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

    this.metricsCollector.increment('writeFailures', failures.length)
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
    fallbackTtl: number | undefined,
    value: unknown
  ): number | undefined {
    return this.ttlResolver.resolveFreshTtl(
      key,
      layerName,
      kind,
      options,
      fallbackTtl,
      this.options.negativeTtl,
      undefined,
      value
    )
  }

  private resolveLayerSeconds(
    layerName: string,
    override: number | LayerTtlMap | undefined,
    globalDefault?: number | LayerTtlMap,
    fallback?: number
  ): number | undefined {
    return this.ttlResolver.resolveLayerSeconds(layerName, override, globalDefault, fallback)
  }

  private shouldNegativeCache(options?: CacheGetOptions): boolean {
    return options?.negativeCache ?? this.options.negativeCaching ?? false
  }

  private scheduleBackgroundRefresh<T>(key: string, fetcher: () => Promise<T>, options?: CacheGetOptions): void {
    if (this.isDisconnecting || this.backgroundRefreshes.has(key)) {
      return
    }

    const refresh = (async () => {
      this.metricsCollector.increment('refreshes')
      try {
        await this.fetchWithGuards(key, fetcher, options)
      } catch (error) {
        this.metricsCollector.increment('refreshErrors')
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
      this.ttlResolver.deleteProfile(key)
      this.circuitBreakerManager.delete(key)
    }

    this.metricsCollector.increment('deletes', keys.length)
    this.metricsCollector.increment('invalidations')
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
      this.ttlResolver.clearProfiles()
      return
    }

    const keys = message.keys ?? []
    await this.deleteKeysFromLayers(localLayers, keys)

    if (message.operation !== 'write') {
      for (const key of keys) {
        await this.tagIndex.remove(key)
        this.ttlResolver.deleteProfile(key)
      }
    }
  }

  private async getTagsForKey(key: string): Promise<string[]> {
    if (this.tagIndex.tagsForKey) {
      return this.tagIndex.tagsForKey(key)
    }
    return []
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

  private initializeWriteBehind(options: CacheWriteBehindOptions | undefined): void {
    if (this.options.writeStrategy !== 'write-behind') {
      return
    }

    const flushIntervalMs = options?.flushIntervalMs
    if (!flushIntervalMs || flushIntervalMs <= 0) {
      return
    }

    this.writeBehindTimer = setInterval(() => {
      void this.flushWriteBehindQueue()
    }, flushIntervalMs)
    this.writeBehindTimer.unref?.()
  }

  private shouldWriteBehind(layer: CacheLayer): boolean {
    return this.options.writeStrategy === 'write-behind' && !layer.isLocal
  }

  private enqueueWriteBehind(operation: () => Promise<void>): void {
    this.writeBehindQueue.push(operation)
    const batchSize = this.options.writeBehind?.batchSize
    if (batchSize && this.writeBehindQueue.length >= batchSize) {
      void this.flushWriteBehindQueue()
    }
  }

  private async flushWriteBehindQueue(): Promise<void> {
    if (this.writeBehindFlushPromise || this.writeBehindQueue.length === 0) {
      await this.writeBehindFlushPromise
      return
    }

    const batchSize = this.options.writeBehind?.batchSize ?? this.writeBehindQueue.length
    const batch = this.writeBehindQueue.splice(0, batchSize)
    this.writeBehindFlushPromise = (async () => {
      await Promise.allSettled(batch.map((operation) => operation()))
    })()

    await this.writeBehindFlushPromise
    this.writeBehindFlushPromise = undefined

    if (this.writeBehindQueue.length > 0) {
      await this.flushWriteBehindQueue()
    }
  }

  private buildLayerSetEntry(
    layer: CacheLayer,
    key: string,
    kind: CacheWriteKind,
    value: unknown,
    options: CacheWriteOptions | undefined,
    now: number
  ): CacheLayerSetManyEntry {
    const freshTtl = this.resolveFreshTtl(key, layer.name, kind, options, layer.defaultTtl, value)
    const staleWhileRevalidate = this.resolveLayerSeconds(
      layer.name,
      options?.staleWhileRevalidate,
      this.options.staleWhileRevalidate
    )
    const staleIfError = this.resolveLayerSeconds(layer.name, options?.staleIfError, this.options.staleIfError)
    const payload = createStoredValueEnvelope({
      kind,
      value,
      freshTtlSeconds: freshTtl,
      staleWhileRevalidateSeconds: staleWhileRevalidate,
      staleIfErrorSeconds: staleIfError,
      now
    })
    const ttl = remainingStoredTtlSeconds(payload, now) ?? freshTtl
    return {
      key,
      value: payload,
      ttl
    }
  }

  private intersectKeys(groups: string[][]): string[] {
    if (groups.length === 0) {
      return []
    }

    const [firstGroup, ...rest] = groups
    if (!firstGroup) {
      return []
    }

    return [...new Set(firstGroup)].filter((key) => rest.every((group) => group.includes(key)))
  }

  private qualifyKey(key: string): string {
    const prefix = this.generationPrefix()
    return prefix ? `${prefix}${key}` : key
  }

  private qualifyPattern(pattern: string): string {
    const prefix = this.generationPrefix()
    return prefix ? `${prefix}${pattern}` : pattern
  }

  private stripQualifiedKey(key: string): string {
    const prefix = this.generationPrefix()
    if (!prefix || !key.startsWith(prefix)) {
      return key
    }
    return key.slice(prefix.length)
  }

  private generationPrefix(): string {
    if (this.currentGeneration === undefined) {
      return ''
    }

    return `v${this.currentGeneration}:`
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

        await Promise.all(
          keys.map(async (key) => {
            try {
              await layer.delete(key)
            } catch (error) {
              await this.handleLayerFailure(layer, 'delete', error)
            }
          })
        )
      })
    )
  }

  private validateConfiguration(): void {
    if (
      this.options.broadcastL1Invalidation !== undefined &&
      this.options.publishSetInvalidation !== undefined &&
      this.options.broadcastL1Invalidation !== this.options.publishSetInvalidation
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
    if (this.options.generation !== undefined) {
      this.validateNonNegativeNumber('generation', this.options.generation)
    }
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
    this.validateTtlPolicy('options.ttlPolicy', options.ttlPolicy)
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

  private validateTtlPolicy(name: string, policy: CacheTtlPolicy | undefined): void {
    if (!policy || typeof policy === 'function' || policy === 'until-midnight' || policy === 'next-hour') {
      return
    }

    if ('alignTo' in policy) {
      this.validatePositiveNumber(`${name}.alignTo`, policy.alignTo)
      return
    }

    throw new Error(`${name} is invalid.`)
  }

  private assertActive(operation: string): void {
    if (this.isDisconnecting) {
      throw new Error(`CacheStack is disconnecting; cannot perform ${operation}.`)
    }
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
    const refreshAhead =
      this.resolveLayerSeconds(hit.layerName, options?.refreshAhead, this.options.refreshAhead, 0) ?? 0
    const remainingFreshTtl = remainingFreshTtlSeconds(hit.stored) ?? 0

    if ((options?.slidingTtl ?? false) && isStoredValueEnvelope(hit.stored)) {
      const refreshed = refreshStoredEnvelope(hit.stored)
      const ttl = remainingStoredTtlSeconds(refreshed)
      for (let index = 0; index <= hit.layerIndex; index += 1) {
        const layer = this.layers[index]
        if (!layer || this.shouldSkipLayer(layer)) {
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

  private shouldSkipLayer(layer: CacheLayer): boolean {
    const degradedUntil = this.layerDegradedUntil.get(layer.name)
    return degradedUntil !== undefined && degradedUntil > Date.now()
  }

  private async handleLayerFailure(layer: CacheLayer, operation: string, error: unknown): Promise<null> {
    if (!this.isGracefulDegradationEnabled()) {
      throw error
    }

    const retryAfterMs =
      typeof this.options.gracefulDegradation === 'object'
        ? (this.options.gracefulDegradation.retryAfterMs ?? 10_000)
        : 10_000

    this.layerDegradedUntil.set(layer.name, Date.now() + retryAfterMs)
    this.metricsCollector.increment('degradedOperations')
    this.logger.warn?.('layer-degraded', { layer: layer.name, operation, error: this.formatError(error) })
    this.emitError(operation, { layer: layer.name, degraded: true, error: this.formatError(error) })
    return null
  }

  private isGracefulDegradationEnabled(): boolean {
    return Boolean(this.options.gracefulDegradation)
  }

  private recordCircuitFailure(key: string, options: CacheCircuitBreakerOptions | undefined, error: unknown): void {
    if (!options) {
      return
    }

    this.circuitBreakerManager.recordFailure(key, options)
    if (this.circuitBreakerManager.isOpen(key)) {
      this.metricsCollector.increment('circuitBreakerTrips')
    }
    this.emitError('fetch', { key, error: this.formatError(error) })
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
    return (
      Array.isArray(value) &&
      value.every((entry) => {
        if (!entry || typeof entry !== 'object') {
          return false
        }

        const candidate = entry as Partial<CacheSnapshotEntry>
        return typeof candidate.key === 'string'
      })
    )
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

function createInstanceId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `layercache-${Date.now()}-${Math.random().toString(36).slice(2)}`
}
