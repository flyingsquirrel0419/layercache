import { EventEmitter } from 'node:events'
import { CacheNamespace, validateNamespaceKey } from './CacheNamespace'
import { CacheKeyDiscovery } from './internal/CacheKeyDiscovery'
import {
  createInstanceId,
  normalizeForSerialization,
  serializeKeyPart,
  serializeOptions
} from './internal/CacheKeySerialization'
import { readUtf8HandleWithLimit, validateSnapshotFilePath } from './internal/CacheSnapshotFile'
import {
  validateAdaptiveTtlOptions,
  validateCacheKey,
  validateCircuitBreakerOptions,
  validateLayerNumberOption,
  validateNonNegativeNumber,
  validatePattern,
  validatePositiveNumber,
  validateRateLimitOptions,
  validateTag,
  validateTags,
  validateTtlPolicy
} from './internal/CacheStackValidation'
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
import { JsonSerializer } from './serialization/JsonSerializer'
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
const DEFAULT_BACKGROUND_REFRESH_TIMEOUT_MS = 30_000
const DEFAULT_SNAPSHOT_MAX_BYTES = 16 * 1_024 * 1_024
const DEFAULT_SNAPSHOT_MAX_ENTRIES = 10_000
const DEFAULT_SNAPSHOT_IMPORT_BATCH_SIZE = 50
const DEFAULT_INVALIDATION_MAX_KEYS = 10_000
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
  private readonly keyDiscovery: CacheKeyDiscovery
  private readonly fetchRateLimiter = new FetchRateLimiter()
  private readonly snapshotSerializer = new JsonSerializer()
  private readonly backgroundRefreshes = new Map<string, Promise<void>>()
  private readonly layerDegradedUntil = new Map<string, number>()
  private readonly keyEpochs = new Map<string, number>()
  private readonly ttlResolver: TtlResolver
  private readonly circuitBreakerManager: CircuitBreakerManager
  private currentGeneration?: number
  private readonly writeBehindQueue: Array<() => Promise<void>> = []
  private writeBehindTimer?: ReturnType<typeof setInterval>
  private writeBehindFlushPromise?: Promise<void>
  private generationCleanupPromise?: Promise<void>
  private clearEpoch = 0
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
    this.keyDiscovery = new CacheKeyDiscovery({
      layers: this.layers,
      tagIndex: this.tagIndex,
      shouldSkipLayer: (layer) => this.shouldSkipLayer(layer),
      handleLayerFailure: async (layer, operation, error) => {
        await this.handleLayerFailure(layer, operation, error)
      }
    })
    if (!options.tagIndex && layers.some((layer) => layer.isLocal === false)) {
      this.logger.warn?.(
        'Using the default in-memory TagIndex with a shared cache layer only tracks keys seen by this process. Use RedisTagIndex for cross-instance tag invalidation.'
      )
    }
    if (!options.tagIndex && layers.some((layer) => layer.isLocal === false && !layer.keys)) {
      this.logger.warn?.(
        'Using the default in-memory TagIndex with a shared cache layer that does not implement keys() can leave invalidateByPattern() and invalidateByPrefix() incomplete after restarts. Use RedisTagIndex or implement keys() on the shared layer.'
      )
    }
    if (
      options.invalidationBus &&
      options.broadcastL1Invalidation === undefined &&
      options.publishSetInvalidation === undefined
    ) {
      this.logger.warn?.(
        'broadcastL1Invalidation defaults to false when an invalidation bus is configured; opt in explicitly if write-triggered L1 invalidation is desired.'
      )
    }
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
    const normalizedKey = this.qualifyKey(validateCacheKey(key))
    this.validateWriteOptions(options)
    await this.awaitStartup('get')
    return this.getPrepared(normalizedKey, fetcher, options)
  }

  private async getPrepared<T>(
    normalizedKey: string,
    fetcher?: () => Promise<T>,
    options?: CacheGetOptions
  ): Promise<T | null> {
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
    const normalizedKey = this.qualifyKey(validateCacheKey(key))
    await this.awaitStartup('has')

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
          await this.reportRecoverableLayerFailure(layer, 'has', new Error(`has() failed for layer "${layer.name}"`))
          // fall through to next layer
        }
      } else {
        try {
          const value = await layer.get(normalizedKey)
          if (value !== null) {
            return true
          }
        } catch (error) {
          await this.reportRecoverableLayerFailure(layer, 'has', error)
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
    const normalizedKey = this.qualifyKey(validateCacheKey(key))
    await this.awaitStartup('ttl')

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
    const normalizedKey = this.qualifyKey(validateCacheKey(key))
    this.validateWriteOptions(options)
    await this.awaitStartup('set')
    await this.storeEntry(normalizedKey, 'value', value, options)
  }

  /**
   * Deletes the key from all layers and publishes an invalidation message.
   */
  async delete(key: string): Promise<void> {
    const normalizedKey = this.qualifyKey(validateCacheKey(key))
    await this.awaitStartup('delete')
    await this.deleteKeys([normalizedKey])
    await this.publishInvalidation({
      scope: 'key',
      keys: [normalizedKey],
      sourceId: this.instanceId,
      operation: 'delete'
    })
  }

  async clear(): Promise<void> {
    await this.awaitStartup('clear')
    this.beginClearEpoch()
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
    if (keys.length === 0) {
      return
    }
    await this.awaitStartup('mdelete')
    const normalizedKeys = keys.map((k) => validateCacheKey(k))
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
      key: this.qualifyKey(validateCacheKey(entry.key))
    }))
    normalizedEntries.forEach((entry) => this.validateWriteOptions(entry.options))
    const canFastPath = normalizedEntries.every((entry) => entry.fetch === undefined && entry.options === undefined)
    if (!canFastPath) {
      await this.awaitStartup('mget')
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
          const optionsSignature = serializeOptions(entry.options)
          const existing = pendingReads.get(entry.key)
          if (!existing) {
            const promise = this.getPrepared(entry.key, entry.fetch, entry.options)
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

    await this.awaitStartup('mget')
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
      key: this.qualifyKey(validateCacheKey(entry.key))
    }))
    normalizedEntries.forEach((entry) => this.validateWriteOptions(entry.options))
    await this.awaitStartup('mset')
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
        : args.map((argument) => serializeKeyPart(argument)).join(':')
      const key = suffix.length > 0 ? `${prefix}:${suffix}` : prefix
      return this.get<TResult>(key, () => fetcher(...args), options)
    }
  }

  /**
   * Creates a `CacheNamespace` that automatically prefixes all keys with
   * `prefix:`. Useful for multi-tenant or module-level isolation.
   */
  namespace(prefix: string): CacheNamespace {
    validateNamespaceKey(prefix)
    return new CacheNamespace(this, prefix)
  }

  async invalidateByTag(tag: string): Promise<void> {
    validateTag(tag)
    await this.awaitStartup('invalidateByTag')
    const keys = await this.collectKeysForTag(tag)
    await this.deleteKeys(keys)
    await this.publishInvalidation({ scope: 'keys', keys, sourceId: this.instanceId, operation: 'invalidate' })
  }

  async invalidateByTags(tags: string[], mode: 'any' | 'all' = 'any'): Promise<void> {
    if (tags.length === 0) {
      return
    }

    validateTags(tags)
    await this.awaitStartup('invalidateByTags')
    const keysByTag = await Promise.all(tags.map((tag) => this.collectKeysForTag(tag)))
    const keys = mode === 'all' ? this.intersectKeys(keysByTag) : [...new Set(keysByTag.flat())]
    this.assertWithinInvalidationKeyLimit(keys.length)

    await this.deleteKeys(keys)
    await this.publishInvalidation({ scope: 'keys', keys, sourceId: this.instanceId, operation: 'invalidate' })
  }

  async invalidateByPattern(pattern: string): Promise<void> {
    validatePattern(pattern)
    await this.awaitStartup('invalidateByPattern')
    const keys = await this.keyDiscovery.collectKeysMatchingPattern(
      this.qualifyPattern(pattern),
      this.invalidationMaxKeys()
    )
    await this.deleteKeys(keys)
    await this.publishInvalidation({ scope: 'keys', keys, sourceId: this.instanceId, operation: 'invalidate' })
  }

  async invalidateByPrefix(prefix: string): Promise<void> {
    await this.awaitStartup('invalidateByPrefix')
    const qualifiedPrefix = this.qualifyKey(validateCacheKey(prefix))
    const keys = await this.keyDiscovery.collectKeysWithPrefix(qualifiedPrefix, this.invalidationMaxKeys())
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

  /**
   * Rotates the active generation prefix used for all future cache keys.
   * Previous-generation keys remain in the underlying layers until they expire,
   * unless `generationCleanup` is enabled to prune them in the background.
   */
  bumpGeneration(nextGeneration?: number): number {
    const current = this.currentGeneration ?? 0
    const previousGeneration = this.currentGeneration
    this.currentGeneration = nextGeneration ?? current + 1
    if (
      previousGeneration !== undefined &&
      previousGeneration !== this.currentGeneration &&
      this.shouldCleanupGenerations()
    ) {
      this.scheduleGenerationCleanup(previousGeneration)
    }
    return this.currentGeneration
  }

  /**
   * Returns detailed metadata about a single cache key: which layers contain it,
   * remaining fresh/stale/error TTLs, and associated tags.
   * Returns `null` if the key does not exist in any layer.
   */
  async inspect(key: string): Promise<CacheInspectResult | null> {
    const userKey = validateCacheKey(key)
    const normalizedKey = this.qualifyKey(userKey)
    await this.awaitStartup('inspect')

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
    await this.awaitStartup('exportState')
    const entries: CacheSnapshotEntry[] = []
    await this.visitExportEntries(this.snapshotMaxEntries(), async (entry) => {
      entries.push(entry)
    })
    return entries
  }

  async importState(entries: CacheSnapshotEntry[]): Promise<void> {
    await this.awaitStartup('importState')
    const normalizedEntries = entries.map((entry) => ({
      key: this.qualifyKey(validateCacheKey(entry.key)),
      value: entry.value,
      ttl: entry.ttl
    }))

    for (let index = 0; index < normalizedEntries.length; index += DEFAULT_SNAPSHOT_IMPORT_BATCH_SIZE) {
      const batch = normalizedEntries.slice(index, index + DEFAULT_SNAPSHOT_IMPORT_BATCH_SIZE)
      await Promise.all(
        batch.map(async (entry) => {
          await Promise.all(this.layers.map((layer) => layer.set(entry.key, entry.value, entry.ttl)))
          await this.tagIndex.touch(entry.key)
        })
      )
    }
  }

  async persistToFile(filePath: string): Promise<void> {
    this.assertActive('persistToFile')
    const { promises: fs } = await import('node:fs')
    const path = await import('node:path')
    const targetPath = await validateSnapshotFilePath(filePath, 'write', this.options.snapshotBaseDir)
    const tempPath = path.join(
      path.dirname(targetPath),
      `.layercache-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`
    )
    let handle: import('node:fs/promises').FileHandle | undefined

    try {
      handle = await fs.open(tempPath, 'wx')
      const openedHandle = handle
      await openedHandle.writeFile('[', 'utf8')

      let wroteAny = false
      await this.visitExportEntries(this.snapshotMaxEntries(), async (entry) => {
        await openedHandle.writeFile(wroteAny ? ',\n' : '\n', 'utf8')
        await openedHandle.writeFile(JSON.stringify(entry, null, 2), 'utf8')
        wroteAny = true
      })

      await openedHandle.writeFile(wroteAny ? '\n]' : ']', 'utf8')
      await openedHandle.close()
      handle = undefined
      await fs.rename(tempPath, targetPath)
    } catch (error) {
      await handle?.close().catch(() => undefined)
      await fs.unlink(tempPath).catch(() => undefined)
      throw error
    }
  }

  async restoreFromFile(filePath: string): Promise<void> {
    this.assertActive('restoreFromFile')
    const { promises: fs, constants } = await import('node:fs')
    const validatedPath = await validateSnapshotFilePath(filePath, 'read', this.options.snapshotBaseDir)
    const handle = await fs.open(validatedPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const snapshotMaxBytes = this.snapshotMaxBytes()
    let raw: string
    try {
      if (snapshotMaxBytes !== false) {
        const stat = await handle.stat()
        if (stat.size > snapshotMaxBytes) {
          throw new Error(
            `Snapshot file exceeds snapshotMaxBytes limit (${stat.size} bytes > ${snapshotMaxBytes} bytes).`
          )
        }
      }

      raw = await readUtf8HandleWithLimit(handle, snapshotMaxBytes)
    } finally {
      await handle.close()
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (cause) {
      throw new Error(`Invalid snapshot file: could not parse JSON (${this.formatError(cause)})`)
    }
    if (!this.isCacheSnapshotEntries(parsed)) {
      throw new Error('Invalid snapshot file: expected an array of { key: string, value, ttl? } entries')
    }
    await this.importState(
      parsed.map((entry) => ({
        key: entry.key,
        value: this.sanitizeSnapshotValue(entry.value),
        ttl: entry.ttl
      }))
    )
  }

  async disconnect(): Promise<void> {
    if (!this.disconnectPromise) {
      this.isDisconnecting = true
      this.disconnectPromise = (async () => {
        await this.startup
        await this.unsubscribeInvalidation?.()
        await this.flushWriteBehindQueue()
        await this.generationCleanupPromise
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
    options?: CacheGetOptions,
    expectedClearEpoch?: number,
    expectedKeyEpoch?: number
  ): Promise<T | null> {
    const fetchTask = async (): Promise<T | null> => {
      const secondHit = await this.readFromLayers<T>(key, options, 'fresh-only')
      if (secondHit.found) {
        this.metricsCollector.increment('hits')
        return secondHit.value
      }

      return this.fetchAndPopulate(key, fetcher, options, expectedClearEpoch, expectedKeyEpoch)
    }

    const singleFlightTask = async (): Promise<T | null> => {
      if (!this.options.singleFlightCoordinator) {
        return fetchTask()
      }

      return this.options.singleFlightCoordinator.execute(key, this.resolveSingleFlightOptions(), fetchTask, () =>
        this.waitForFreshValue(key, fetcher, options, expectedClearEpoch, expectedKeyEpoch)
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
    options?: CacheGetOptions,
    expectedClearEpoch?: number,
    expectedKeyEpoch?: number
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

    return this.fetchAndPopulate(key, fetcher, options, expectedClearEpoch, expectedKeyEpoch)
  }

  private async fetchAndPopulate<T>(
    key: string,
    fetcher: () => Promise<T>,
    options?: CacheGetOptions,
    expectedClearEpoch?: number,
    expectedKeyEpoch?: number
  ): Promise<T | null> {
    this.circuitBreakerManager.assertClosed(key, options?.circuitBreaker ?? this.options.circuitBreaker)
    this.metricsCollector.increment('fetches')
    const fetchStart = Date.now()
    let fetched: T

    try {
      fetched = await this.fetchRateLimiter.schedule(
        options?.fetcherRateLimit ?? this.options.fetcherRateLimit,
        { key, fetcher },
        fetcher
      )
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

      if (this.isWriteOutdated(key, expectedClearEpoch, expectedKeyEpoch)) {
        this.logger.debug?.('skip-negative-store-after-invalidation', {
          key,
          expectedClearEpoch,
          clearEpoch: this.clearEpoch,
          expectedKeyEpoch,
          keyEpoch: this.currentKeyEpoch(key)
        })
        return null
      }

      await this.storeEntry(key, 'empty', null, options)
      return null
    }

    // Conditional caching: skip storage if shouldCache returns false
    if (options?.shouldCache) {
      try {
        if (!options.shouldCache(fetched)) {
          return fetched
        }
      } catch (error) {
        this.logger.warn?.('shouldCache-error', { key, error: this.formatError(error) })
      }
    }

    if (this.isWriteOutdated(key, expectedClearEpoch, expectedKeyEpoch)) {
      this.logger.debug?.('skip-store-after-invalidation', {
        key,
        expectedClearEpoch,
        clearEpoch: this.clearEpoch,
        expectedKeyEpoch,
        keyEpoch: this.currentKeyEpoch(key)
      })
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
    const clearEpoch = this.clearEpoch
    const keyEpoch = this.currentKeyEpoch(key)
    await this.writeAcrossLayers(key, kind, value, options)
    if (this.isWriteOutdated(key, clearEpoch, keyEpoch)) {
      return
    }
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

  private async writeBatch(
    entries: Array<{ key: string; value: unknown; options?: CacheWriteOptions }>
  ): Promise<void> {
    const now = Date.now()
    const clearEpoch = this.clearEpoch
    const entryEpochs = new Map(entries.map((entry) => [entry.key, this.currentKeyEpoch(entry.key)]))
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
        if (clearEpoch !== this.clearEpoch) {
          return
        }
        const activeEntries = layerEntries.filter(
          (entry) => (entryEpochs.get(entry.key) ?? 0) === this.currentKeyEpoch(entry.key)
        )
        if (activeEntries.length === 0) {
          return
        }
        try {
          if (layer.setMany) {
            await layer.setMany(activeEntries)
            return
          }

          await Promise.all(activeEntries.map((entry) => layer.set(entry.key, entry.value, entry.ttl)))
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
    await Promise.all(deferredOperations.map((operation) => this.enqueueWriteBehind(operation)))
    if (clearEpoch !== this.clearEpoch) {
      return
    }

    for (const entry of entries) {
      if (this.isWriteOutdated(entry.key, clearEpoch, entryEpochs.get(entry.key))) {
        continue
      }
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
    const clearEpoch = this.clearEpoch
    const keyEpoch = this.currentKeyEpoch(key)
    const immediateOperations: Array<() => Promise<void>> = []
    const deferredOperations: Array<() => Promise<void>> = []

    for (const layer of this.layers) {
      const operation = async () => {
        if (this.isWriteOutdated(key, clearEpoch, keyEpoch)) {
          return
        }
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
    await Promise.all(deferredOperations.map((operation) => this.enqueueWriteBehind(operation)))
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

    const clearEpoch = this.clearEpoch
    const keyEpoch = this.currentKeyEpoch(key)
    const refresh = (async () => {
      this.metricsCollector.increment('refreshes')
      try {
        await this.runBackgroundRefresh(key, fetcher, options, clearEpoch, keyEpoch)
      } catch (error) {
        this.metricsCollector.increment('refreshErrors')
        this.logger.debug?.('refresh-error', { key, error: this.formatError(error) })
      } finally {
        this.backgroundRefreshes.delete(key)
      }
    })()

    this.backgroundRefreshes.set(key, refresh)
  }

  private async runBackgroundRefresh<T>(
    key: string,
    fetcher: () => Promise<T>,
    options?: CacheGetOptions,
    expectedClearEpoch?: number,
    expectedKeyEpoch?: number
  ): Promise<void> {
    const timeoutMs = this.options.backgroundRefreshTimeoutMs ?? DEFAULT_BACKGROUND_REFRESH_TIMEOUT_MS
    await this.fetchWithGuards(
      key,
      () =>
        this.withTimeout(fetcher(), timeoutMs, () => {
          return new Error(`Background refresh timed out after ${timeoutMs}ms for key "${key}".`)
        }),
      options,
      expectedClearEpoch,
      expectedKeyEpoch
    )
  }

  private resolveSingleFlightOptions(): CacheSingleFlightExecutionOptions {
    return {
      leaseMs: this.options.singleFlightLeaseMs ?? DEFAULT_SINGLE_FLIGHT_LEASE_MS,
      waitTimeoutMs: this.options.singleFlightTimeoutMs ?? DEFAULT_SINGLE_FLIGHT_TIMEOUT_MS,
      pollIntervalMs: this.options.singleFlightPollMs ?? DEFAULT_SINGLE_FLIGHT_POLL_MS,
      renewIntervalMs: this.options.singleFlightRenewIntervalMs
    }
  }

  private async deleteKeys(keys: string[]): Promise<void> {
    if (keys.length === 0) {
      return
    }

    this.bumpKeyEpochs(keys)
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
    if (message.scope === 'clear') {
      this.beginClearEpoch()
      await Promise.all(localLayers.map((layer) => layer.clear()))
      await this.tagIndex.clear()
      this.ttlResolver.clearProfiles()
      this.circuitBreakerManager.clear()
      return
    }

    const keys = message.keys ?? []
    this.bumpKeyEpochs(keys)
    await this.deleteKeysFromLayers(localLayers, keys)

    if (message.operation !== 'write') {
      for (const key of keys) {
        await this.tagIndex.remove(key)
        this.ttlResolver.deleteProfile(key)
        this.circuitBreakerManager.delete(key)
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

  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number, onTimeout: () => Error): Promise<T> {
    if (timeoutMs <= 0) {
      return promise
    }

    let timer: ReturnType<typeof setTimeout> | undefined
    const observedPromise = promise.then(
      (value) => ({ kind: 'value' as const, value }),
      (error) => ({ kind: 'error' as const, error })
    )
    try {
      const result = await Promise.race([
        observedPromise,
        new Promise<T>((_, reject) => {
          timer = setTimeout(() => reject(onTimeout()), timeoutMs)
          timer.unref?.()
        })
      ])
      if (result && typeof result === 'object' && 'kind' in result) {
        if (result.kind === 'error') {
          throw result.error
        }
        return result.value
      }
      return result
    } finally {
      if (timer) {
        clearTimeout(timer)
      }
    }
  }

  private shouldBroadcastL1Invalidation(): boolean {
    return this.options.broadcastL1Invalidation ?? this.options.publishSetInvalidation ?? false
  }

  private shouldCleanupGenerations(): boolean {
    return Boolean(this.options.generationCleanup)
  }

  private generationCleanupBatchSize(): number {
    const configured =
      typeof this.options.generationCleanup === 'object' ? this.options.generationCleanup.batchSize : undefined
    return configured ?? 500
  }

  private scheduleGenerationCleanup(generation: number): void {
    const task = (this.generationCleanupPromise ?? Promise.resolve())
      .then(() => this.cleanupGeneration(generation))
      .catch((error) => {
        this.logger.warn?.('generation-cleanup-error', {
          generation,
          error: this.formatError(error)
        })
      })

    this.generationCleanupPromise = task.finally(() => {
      if (this.generationCleanupPromise === task) {
        this.generationCleanupPromise = undefined
      }
    })
  }

  private async cleanupGeneration(generation: number): Promise<void> {
    const prefix = `v${generation}:`
    const keys = await this.keyDiscovery.collectKeysWithPrefix(prefix)
    if (keys.length === 0) {
      return
    }

    const batchSize = this.generationCleanupBatchSize()
    for (let index = 0; index < keys.length; index += batchSize) {
      const batch = keys.slice(index, index + batchSize)
      await this.deleteKeys(batch)
      await this.publishInvalidation({
        scope: 'keys',
        keys: batch,
        sourceId: this.instanceId,
        operation: 'invalidate'
      })
    }
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

  private beginClearEpoch(): void {
    this.clearEpoch += 1
    this.keyEpochs.clear()
    this.writeBehindQueue.length = 0
  }

  private currentKeyEpoch(key: string): number {
    return this.keyEpochs.get(key) ?? 0
  }

  private bumpKeyEpochs(keys: string[]): void {
    for (const key of keys) {
      this.keyEpochs.set(key, this.currentKeyEpoch(key) + 1)
    }
  }

  private isWriteOutdated(key: string, expectedClearEpoch?: number, expectedKeyEpoch?: number): boolean {
    if (expectedClearEpoch !== undefined && expectedClearEpoch !== this.clearEpoch) {
      return true
    }

    if (expectedKeyEpoch !== undefined && expectedKeyEpoch !== this.currentKeyEpoch(key)) {
      return true
    }

    return false
  }

  private async enqueueWriteBehind(operation: () => Promise<void>): Promise<void> {
    this.writeBehindQueue.push(operation)
    const batchSize = this.options.writeBehind?.batchSize ?? 100
    const maxQueueSize = this.options.writeBehind?.maxQueueSize ?? batchSize * 10

    if (this.writeBehindQueue.length >= batchSize) {
      await this.flushWriteBehindQueue()
      return
    }

    if (this.writeBehindQueue.length >= maxQueueSize) {
      await this.flushWriteBehindQueue()
    }
  }

  private async flushWriteBehindQueue(): Promise<void> {
    if (this.writeBehindFlushPromise || this.writeBehindQueue.length === 0) {
      await this.writeBehindFlushPromise
      return
    }

    const batchSize = this.options.writeBehind?.batchSize ?? 100
    const batch = this.writeBehindQueue.splice(0, batchSize)
    this.writeBehindFlushPromise = (async () => {
      const results = await Promise.allSettled(batch.map((operation) => operation()))
      const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      if (failures.length > 0) {
        this.metricsCollector.increment('writeFailures', failures.length)
        this.logger.error?.('write-behind-flush-failure', {
          failed: failures.length,
          total: batch.length,
          errors: failures.map((failure) => this.formatError(failure.reason))
        })
        this.emitError('write-behind', { failed: failures.length, total: batch.length })
      }
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

    const restSets = rest.map((group) => new Set(group))
    return [...new Set(firstGroup)].filter((key) => restSets.every((group) => group.has(key)))
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

    validateLayerNumberOption('negativeTtl', this.options.negativeTtl)
    validateLayerNumberOption('staleWhileRevalidate', this.options.staleWhileRevalidate)
    validateLayerNumberOption('staleIfError', this.options.staleIfError)
    validateLayerNumberOption('ttlJitter', this.options.ttlJitter)
    validateLayerNumberOption('refreshAhead', this.options.refreshAhead)
    validatePositiveNumber('singleFlightLeaseMs', this.options.singleFlightLeaseMs)
    validatePositiveNumber('singleFlightTimeoutMs', this.options.singleFlightTimeoutMs)
    validatePositiveNumber('singleFlightPollMs', this.options.singleFlightPollMs)
    validatePositiveNumber('singleFlightRenewIntervalMs', this.options.singleFlightRenewIntervalMs)
    validatePositiveNumber('backgroundRefreshTimeoutMs', this.options.backgroundRefreshTimeoutMs)
    if (this.options.snapshotMaxBytes !== false) {
      validatePositiveNumber('snapshotMaxBytes', this.options.snapshotMaxBytes)
    }
    if (this.options.snapshotMaxEntries !== false) {
      validatePositiveNumber('snapshotMaxEntries', this.options.snapshotMaxEntries)
    }
    if (this.options.invalidationMaxKeys !== false) {
      validatePositiveNumber('invalidationMaxKeys', this.options.invalidationMaxKeys)
    }
    validateRateLimitOptions('fetcherRateLimit', this.options.fetcherRateLimit)
    validateAdaptiveTtlOptions(this.options.adaptiveTtl)
    validateCircuitBreakerOptions(this.options.circuitBreaker)
    if (typeof this.options.generationCleanup === 'object') {
      validatePositiveNumber('generationCleanup.batchSize', this.options.generationCleanup.batchSize)
    }
    if (this.options.generation !== undefined) {
      validateNonNegativeNumber('generation', this.options.generation)
    }
  }

  private validateWriteOptions(options: CacheWriteOptions | undefined): void {
    if (!options) {
      return
    }

    validateLayerNumberOption('options.ttl', options.ttl)
    validateLayerNumberOption('options.negativeTtl', options.negativeTtl)
    validateLayerNumberOption('options.staleWhileRevalidate', options.staleWhileRevalidate)
    validateLayerNumberOption('options.staleIfError', options.staleIfError)
    validateLayerNumberOption('options.ttlJitter', options.ttlJitter)
    validateLayerNumberOption('options.refreshAhead', options.refreshAhead)
    validateTtlPolicy('options.ttlPolicy', options.ttlPolicy)
    validateAdaptiveTtlOptions(options.adaptiveTtl)
    validateCircuitBreakerOptions(options.circuitBreaker)
    validateRateLimitOptions('options.fetcherRateLimit', options.fetcherRateLimit)
    validateTags(options.tags)
  }

  private assertActive(operation: string): void {
    if (this.isDisconnecting) {
      throw new Error(`CacheStack is disconnecting; cannot perform ${operation}.`)
    }
  }

  private async awaitStartup(operation: string): Promise<void> {
    this.assertActive(operation)
    await this.startup
    this.assertActive(operation)
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

  private async reportRecoverableLayerFailure(layer: CacheLayer, operation: string, error: unknown): Promise<void> {
    if (this.isGracefulDegradationEnabled()) {
      await this.handleLayerFailure(layer, operation, error)
      return
    }

    this.logger.warn?.('layer-operation-failed', { layer: layer.name, operation, error: this.formatError(error) })
    this.emitError(operation, { layer: layer.name, degraded: false, error: this.formatError(error) })
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

  private isCacheSnapshotEntries(value: unknown): value is CacheSnapshotEntry[] {
    return (
      Array.isArray(value) &&
      value.every((entry) => {
        if (!entry || typeof entry !== 'object') {
          return false
        }

        const candidate = entry as Partial<CacheSnapshotEntry>
        return (
          typeof candidate.key === 'string' &&
          (candidate.ttl === undefined ||
            (typeof candidate.ttl === 'number' && Number.isFinite(candidate.ttl) && candidate.ttl >= 0))
        )
      })
    )
  }

  private sanitizeSnapshotValue(value: unknown): unknown {
    return this.snapshotSerializer.deserialize(this.snapshotSerializer.serialize(value))
  }

  private snapshotMaxBytes(): number | false {
    return this.options.snapshotMaxBytes === false
      ? false
      : (this.options.snapshotMaxBytes ?? DEFAULT_SNAPSHOT_MAX_BYTES)
  }

  private snapshotMaxEntries(): number | false {
    return this.options.snapshotMaxEntries === false
      ? false
      : (this.options.snapshotMaxEntries ?? DEFAULT_SNAPSHOT_MAX_ENTRIES)
  }

  private invalidationMaxKeys(): number | false {
    return this.options.invalidationMaxKeys === false
      ? false
      : (this.options.invalidationMaxKeys ?? DEFAULT_INVALIDATION_MAX_KEYS)
  }

  private async collectKeysForTag(tag: string): Promise<string[]> {
    const keys = new Set<string>()

    if (this.tagIndex.forEachKeyForTag) {
      await this.tagIndex.forEachKeyForTag(tag, async (key) => {
        keys.add(key)
        this.assertWithinInvalidationKeyLimit(keys.size)
      })
      return [...keys]
    }

    for (const key of await this.tagIndex.keysForTag(tag)) {
      keys.add(key)
      this.assertWithinInvalidationKeyLimit(keys.size)
    }

    return [...keys]
  }

  private assertWithinInvalidationKeyLimit(size: number): void {
    const maxKeys = this.invalidationMaxKeys()
    if (maxKeys !== false && size > maxKeys) {
      throw new Error(`Invalidation matched too many keys (${size} > ${maxKeys}).`)
    }
  }

  private async visitExportEntries(
    maxEntries: number | false,
    visitor: (entry: CacheSnapshotEntry) => Promise<void> | void
  ): Promise<void> {
    const exported = new Set<string>()

    for (const layer of this.layers) {
      if (!layer.keys && !layer.forEachKey) {
        continue
      }

      const visitKey = async (key: string): Promise<void> => {
        const exportedKey = this.stripQualifiedKey(key)
        if (exported.has(exportedKey)) {
          return
        }

        const stored = await this.readLayerEntry(layer, key)
        if (stored === null) {
          return
        }

        exported.add(exportedKey)
        if (maxEntries !== false && exported.size > maxEntries) {
          throw new Error(`Snapshot export exceeds snapshotMaxEntries limit (${exported.size} > ${maxEntries}).`)
        }
        await visitor({
          key: exportedKey,
          value: stored,
          ttl: remainingStoredTtlSeconds(stored)
        })
      }

      if (layer.forEachKey) {
        await layer.forEachKey(visitKey)
        continue
      }

      const keys = await layer.keys?.()
      for (const key of keys ?? []) {
        await visitKey(key)
      }
    }
  }
}
