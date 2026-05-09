import { EventEmitter } from 'node:events'
import { CacheNamespace, validateNamespaceKey } from './CacheNamespace'
import { CacheKeyDiscovery } from './internal/CacheKeyDiscovery'
import {
  createInstanceId,
  normalizeForSerialization,
  serializeKeyPart,
  serializeOptions
} from './internal/CacheKeySerialization'
import {
  generationPrefix,
  planGenerationCleanupBatches,
  qualifyGenerationKey,
  qualifyGenerationPattern,
  resolveGenerationCleanupTarget,
  stripGenerationPrefix
} from './internal/CacheStackGeneration'
import { CacheStackInvalidationSupport } from './internal/CacheStackInvalidationSupport'
import { CacheStackLayerWriter, type CacheWriteKind } from './internal/CacheStackLayerWriter'
import { CacheStackMaintenance } from './internal/CacheStackMaintenance'
import { CacheStackReader } from './internal/CacheStackReader'
import {
  resolveRecoverableLayerFailure,
  shouldSkipLayer as shouldSkipDegradedLayer
} from './internal/CacheStackRuntimePolicy'
import { CacheStackSnapshotManager } from './internal/CacheStackSnapshotManager'
import {
  validateAdaptiveTtlOptions,
  validateCacheKey,
  validateCircuitBreakerOptions,
  validateContextEntryOptions,
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
import { resolveStoredValue } from './internal/StoredValue'
import { TtlResolver } from './internal/TtlResolver'
import { TagIndex } from './invalidation/TagIndex'
import { JsonSerializer } from './serialization/JsonSerializer'
import { StampedeGuard } from './stampede/StampedeGuard'
import {
  type CacheAdaptiveTtlOptions,
  type CacheCircuitBreakerOptions,
  type CacheContextOptionsContext,
  type CacheEntryResult,
  type CacheEntryWriteKind,
  type CacheEntryWriteOptions,
  type CacheFetcher,
  type CacheFetcherContext,
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

const DEFAULT_SNAPSHOT_MAX_BYTES = 16 * 1_024 * 1_024
const DEFAULT_SNAPSHOT_MAX_ENTRIES = 10_000
const DEFAULT_INVALIDATION_MAX_KEYS = 10_000
const DEFAULT_MAX_PROFILE_ENTRIES = 100_000

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
  /** Register a typed CacheStack event listener. */
  on<K extends keyof CacheStackEvents>(event: K, listener: (data: CacheStackEvents[K]) => void): this
  /** Register a typed CacheStack event listener that runs once. */
  once<K extends keyof CacheStackEvents>(event: K, listener: (data: CacheStackEvents[K]) => void): this
  /** Remove a typed CacheStack event listener. */
  off<K extends keyof CacheStackEvents>(event: K, listener: (data: CacheStackEvents[K]) => void): this
  /** Remove all listeners, optionally only for one typed CacheStack event. */
  removeAllListeners<K extends keyof CacheStackEvents>(event?: K): this
  /** Return listeners registered for a typed CacheStack event. */
  listeners<K extends keyof CacheStackEvents>(event: K): Array<(data: CacheStackEvents[K]) => void>
  /** Return the listener count for a typed CacheStack event. */
  listenerCount<K extends keyof CacheStackEvents>(event: K): number
  /** Emit a typed CacheStack event. Mostly useful for custom integrations. */
  emit<K extends keyof CacheStackEvents>(event: K, data: CacheStackEvents[K]): boolean
}

/**
 * Multi-layer read-through cache coordinator.
 *
 * Layers are checked from fastest to slowest, partial hits are backfilled into
 * faster layers, and misses can be resolved by read-through fetchers.
 */
export class CacheStack extends EventEmitter {
  private readonly stampedeGuard: StampedeGuard
  private readonly metricsCollector = new MetricsCollector()
  private readonly instanceId = createInstanceId()
  private readonly startup: Promise<void>
  private unsubscribeInvalidation?: () => Promise<void> | void
  private readonly logger: CacheLogger
  private readonly tagIndex: CacheTagIndex
  private readonly keyDiscovery: CacheKeyDiscovery
  private readonly fetchRateLimiter = new FetchRateLimiter()
  private readonly snapshotSerializer = new JsonSerializer()
  private readonly invalidation: CacheStackInvalidationSupport
  private readonly layerWriter: CacheStackLayerWriter
  private readonly snapshots: CacheStackSnapshotManager
  private readonly layerDegradedUntil = new Map<string, number>()
  private readonly maintenance = new CacheStackMaintenance()
  private readonly ttlResolver: TtlResolver
  private readonly circuitBreakerManager: CircuitBreakerManager
  private nextOperationId = 0
  private currentGeneration?: number
  private isDisconnecting = false
  private readonly reader: CacheStackReader
  private disconnectPromise?: Promise<void>

  /**
   * Creates a cache stack from ordered layers and optional global behavior settings.
   */
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
    this.stampedeGuard = new StampedeGuard({
      maxInFlight: options.stampedeMaxInFlight,
      entryTimeoutMs: options.stampedeEntryTimeoutMs
    })
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
    this.invalidation = new CacheStackInvalidationSupport({
      tagIndex: this.tagIndex,
      shouldSkipLayer: (layer) => this.shouldSkipLayer(layer),
      handleLayerFailure: async (layer, operation, error) => {
        await this.handleLayerFailure(layer, operation, error)
      }
    })
    this.layerWriter = new CacheStackLayerWriter({
      layers: this.layers,
      maintenance: this.maintenance,
      shouldSkipLayer: (layer) => this.shouldSkipLayer(layer),
      shouldWriteBehind: (layer) => this.shouldWriteBehind(layer),
      handleLayerFailure: async (layer, operation, error) => {
        await this.handleLayerFailure(layer, operation, error)
      },
      enqueueWriteBehind: this.enqueueWriteBehind.bind(this),
      resolveFreshTtl: this.resolveFreshTtl.bind(this),
      resolveLayerMs: this.resolveLayerMs.bind(this),
      globalStaleWhileRevalidate: this.options.staleWhileRevalidate,
      globalStaleIfError: this.options.staleIfError,
      writePolicy: this.options.writePolicy,
      onWriteFailures: (context, failures) => {
        this.metricsCollector.increment('writeFailures', failures.length)
        this.logger.debug?.('write-failure', {
          ...context,
          failures: failures.map((failure) => this.formatError(failure))
        })
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
    this.snapshots = new CacheStackSnapshotManager({
      layers: this.layers,
      tagIndex: this.tagIndex,
      snapshotSerializer: this.snapshotSerializer,
      readLayerEntry: (layer, key) => this.reader.readLayerEntry(layer, key),
      shouldSkipLayer: (layer) => this.shouldSkipLayer(layer),
      handleLayerFailure: async (layer, operation, error) => this.handleLayerFailure(layer, operation, error),
      qualifyKey: this.qualifyKey.bind(this),
      stripQualifiedKey: this.stripQualifiedKey.bind(this),
      validateCacheKey,
      formatError: this.formatError.bind(this)
    })
    this.reader = new CacheStackReader({
      layers: this.layers,
      metricsCollector: this.metricsCollector,
      maintenance: this.maintenance,
      tagIndex: this.tagIndex,
      circuitBreakerManager: this.circuitBreakerManager,
      fetchRateLimiter: this.fetchRateLimiter,
      stampedeGuard: this.stampedeGuard,
      ttlResolver: this.ttlResolver,
      logger: this.logger,
      shouldSkipLayer: (layer) => this.shouldSkipLayer(layer),
      handleLayerFailure: async (layer, operation, error) => this.handleLayerFailure(layer, operation, error),
      emit: (event, data) => this.emit(event, data as never),
      emitError: (operation, context) => this.emitError(operation, context),
      formatError: (error) => this.formatError(error),
      storeEntry: (key, kind, value, options) => this.storeEntry(key, kind, value, options),
      recordCircuitFailure: (key, breakerKey, options, error) =>
        this.recordCircuitFailure(key, breakerKey, options, error),
      resolveLayerMs: (layerName, override, globalDefault, fallback) =>
        this.resolveLayerMs(layerName, override, globalDefault, fallback),
      sleep: (ms) => this.sleep(ms),
      withTimeout: (promise, ms, createError) => this.withTimeout(promise, ms, createError),
      isDisconnecting: () => this.isDisconnecting,
      isGracefulDegradationEnabled: () => this.isGracefulDegradationEnabled(),
      scheduleBackgroundRefreshDispatch: <T>(
        key: string,
        fetcher: CacheFetcher<T>,
        options?: CacheGetOptions,
        fetcherContext?: CacheFetcherContext<T>
      ) => this.scheduleBackgroundRefresh(key, fetcher, options, fetcherContext),
      stampedePrevention: options.stampedePrevention,
      singleFlightCoordinator: options.singleFlightCoordinator,
      singleFlightLeaseMs: options.singleFlightLeaseMs,
      singleFlightTimeoutMs: options.singleFlightTimeoutMs,
      singleFlightPollMs: options.singleFlightPollMs,
      singleFlightRenewIntervalMs: options.singleFlightRenewIntervalMs,
      backgroundRefreshTimeoutMs: options.backgroundRefreshTimeoutMs,
      negativeCaching: options.negativeCaching,
      cacheNullValues: options.cacheNullValues,
      refreshAhead: options.refreshAhead,
      circuitBreaker: options.circuitBreaker,
      fetcherRateLimit: options.fetcherRateLimit
    })
    this.initializeWriteBehind(options.writeBehind)
    this.startup = this.initialize()
  }

  /**
   * Read-through cache get.
   * Returns the cached value if present and fresh, or invokes `fetcher` on a miss
   * and stores the result across all layers. Returns `null` if the key is not found
   * and no `fetcher` is provided.
   */
  async get<T>(key: string, fetcher?: CacheFetcher<T>, options?: CacheGetOptions): Promise<T | null> {
    return this.observeOperation('layercache.get', { 'layercache.key': String(key ?? '') }, async () => {
      const normalizedKey = this.qualifyKey(validateCacheKey(key))
      this.validateWriteOptions(options)
      await this.awaitStartup('get')
      return this.reader.getPrepared(normalizedKey, fetcher, options)
    })
  }

  /**
   * Alias for `get(key, fetcher, options)` — explicit get-or-set pattern.
   * Fetches and caches the value if not already present.
   */
  async getOrSet<T>(key: string, fetcher: CacheFetcher<T>, options?: CacheGetOptions): Promise<T | null> {
    return this.get(key, fetcher, options)
  }

  /**
   * Returns a discriminated cache entry, or `null` on miss.
   * Unlike `get()`, this distinguishes a stored `null` value from an absent key.
   */
  async getEntry<T>(key: string): Promise<CacheEntryResult<T> | null> {
    const userKey = validateCacheKey(key)
    const normalizedKey = this.qualifyKey(userKey)
    await this.awaitStartup('getEntry')

    for (const layer of this.layers) {
      if (this.shouldSkipLayer(layer)) {
        continue
      }

      const stored = await this.readLayerEntry(layer, normalizedKey)
      if (stored === null) {
        continue
      }

      const resolved = resolveStoredValue<T>(stored)
      if (resolved.state === 'expired') {
        continue
      }

      return {
        key: userKey,
        value: resolved.value,
        kind: resolved.envelope?.kind ?? 'value',
        state: resolved.state,
        layer: layer.name
      }
    }

    return null
  }

  /**
   * Like `get()`, but throws `CacheMissError` instead of returning `null`.
   * Useful when the value is expected to exist or the fetcher is expected to
   * return non-null.
   */
  async getOrThrow<T>(key: string, fetcher?: CacheFetcher<T>, options?: CacheGetOptions): Promise<T> {
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
   * Returns the remaining TTL in milliseconds for the key in the fastest layer
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
    await this.observeOperation('layercache.set', { 'layercache.key': String(key ?? '') }, async () => {
      const normalizedKey = this.qualifyKey(validateCacheKey(key))
      this.validateWriteOptions(options)
      await this.awaitStartup('set')
      await this.storeEntry(normalizedKey, 'value', value, options)
    })
  }

  /**
   * Deletes the key from all layers and publishes an invalidation message.
   */
  async delete(key: string): Promise<void> {
    await this.observeOperation('layercache.delete', { 'layercache.key': String(key ?? '') }, async () => {
      const normalizedKey = this.qualifyKey(validateCacheKey(key))
      await this.awaitStartup('delete')
      await this.deleteKeys([normalizedKey])
      await this.publishInvalidation({
        scope: 'key',
        keys: [normalizedKey],
        sourceId: this.instanceId,
        operation: 'delete'
      })
    })
  }

  /**
   * Clears every configured layer, removes tag metadata, resets internal TTL
   * profiles, and broadcasts a clear invalidation message.
   */
  async clear(): Promise<void> {
    await this.awaitStartup('clear')
    this.maintenance.beginClearEpoch()
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

  /**
   * Alias for `delete(key)` that matches the `invalidateBy*` API family.
   */
  async invalidateByKey(key: string): Promise<void> {
    await this.delete(key)
  }

  /**
   * Alias for `mdelete(keys)` that matches the `invalidateBy*` API family.
   */
  async invalidateByKeys(keys: string[]): Promise<void> {
    await this.mdelete(keys)
  }

  /**
   * Marks one exact key expired without deleting its stale value.
   */
  async expireByKey(key: string): Promise<void> {
    await this.observeOperation('layercache.expire_by_key', { 'layercache.key': String(key ?? '') }, async () => {
      const normalizedKey = this.qualifyKey(validateCacheKey(key))
      await this.awaitStartup('expireByKey')
      await this.expireKeys([normalizedKey])
      await this.publishInvalidation({
        scope: 'key',
        keys: [normalizedKey],
        sourceId: this.instanceId,
        operation: 'expire'
      })
    })
  }

  /**
   * Marks multiple exact keys expired without deleting their stale values.
   */
  async expireByKeys(keys: string[]): Promise<void> {
    await this.observeOperation('layercache.expire_by_keys', undefined, async () => {
      if (keys.length === 0) {
        return
      }

      const normalizedKeys = keys.map((k) => validateCacheKey(k))
      const cacheKeys = normalizedKeys.map((key) => this.qualifyKey(key))
      await this.awaitStartup('expireByKeys')
      await this.expireKeys(cacheKeys)
      await this.publishInvalidation({
        scope: 'keys',
        keys: cacheKeys,
        sourceId: this.instanceId,
        operation: 'expire'
      })
    })
  }

  /**
   * Reads many keys concurrently. Simple reads use layer-level bulk fast paths;
   * entries with fetchers or options fall back to per-entry read-through logic.
   */
  async mget<T>(entries: CacheMGetEntry<T>[]): Promise<Array<T | null>> {
    return this.observeOperation('layercache.mget', undefined, async () => {
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
            fetch?: CacheFetcher<T>
            optionsSignature: string
          }
        >()

        return Promise.all(
          normalizedEntries.map((entry) => {
            const optionsSignature = serializeOptions(entry.options)
            const existing = pendingReads.get(entry.key)
            if (!existing) {
              const promise = this.reader.getPrepared(entry.key, entry.fetch, entry.options)
              pendingReads.set(entry.key, {
                promise,
                fetch: entry.fetch,
                optionsSignature
              })
              return promise
            }

            if (existing.fetch !== entry.fetch || existing.optionsSignature !== optionsSignature) {
              const displayKey = entry.key.length > 64 ? `${entry.key.slice(0, 64)}...` : entry.key
              throw new Error(`mget received conflicting entries for key "${displayKey}".`)
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
        if (!layer || this.shouldSkipLayer(layer)) continue
        const keys = [...pending]
        if (keys.length === 0) {
          break
        }

        const values = layer.getMany
          ? await layer.getMany(keys)
          : await Promise.all(keys.map((key) => this.reader.readLayerEntry(layer, key)))

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

          if (resolved.state === 'stale-while-revalidate' || resolved.state === 'stale-if-error') {
            this.metricsCollector.increment('staleHits', indexesByKey.get(key)?.length ?? 1)
          }

          await this.tagIndex.touch(key)
          await this.reader.backfill(key, stored, layerIndex - 1)
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
    })
  }

  /**
   * Writes many entries concurrently using each layer's bulk write fast path
   * when available.
   */
  async mset<T>(entries: CacheMSetEntry<T>[]): Promise<void> {
    await this.observeOperation('layercache.mset', undefined, async () => {
      this.assertActive('mset')
      const normalizedEntries = entries.map((entry) => ({
        ...entry,
        key: this.qualifyKey(validateCacheKey(entry.key))
      }))
      normalizedEntries.forEach((entry) => this.validateWriteOptions(entry.options))
      await this.awaitStartup('mset')
      await this.writeBatch(normalizedEntries)
    })
  }

  /**
   * Pre-populates cache entries by running their fetchers with bounded
   * concurrency. Higher-priority entries run first.
   */
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

  /**
   * Deletes every key currently associated with `tag` and broadcasts an
   * invalidation message.
   */
  async invalidateByTag(tag: string): Promise<void> {
    await this.observeOperation('layercache.invalidate_by_tag', undefined, async () => {
      validateTag(tag)
      await this.awaitStartup('invalidateByTag')
      const keys = await this.invalidation.collectKeysForTag(tag, this.invalidationMaxKeys())
      await this.deleteKeys(keys)
      await this.publishInvalidation({ scope: 'keys', keys, sourceId: this.instanceId, operation: 'invalidate' })
    })
  }

  /**
   * Marks every key associated with `tag` as expired while preserving stale
   * windows for stale serving.
   */
  async expireByTag(tag: string): Promise<void> {
    await this.observeOperation('layercache.expire_by_tag', undefined, async () => {
      validateTag(tag)
      await this.awaitStartup('expireByTag')
      const keys = await this.invalidation.collectKeysForTag(tag, this.invalidationMaxKeys())
      await this.expireKeys(keys)
      await this.publishInvalidation({ scope: 'keys', keys, sourceId: this.instanceId, operation: 'expire' })
    })
  }

  /**
   * Deletes keys associated with any or all of the provided tags and broadcasts
   * an invalidation message.
   */
  async invalidateByTags(tags: string[], mode: 'any' | 'all' = 'any'): Promise<void> {
    await this.observeOperation('layercache.invalidate_by_tags', undefined, async () => {
      if (tags.length === 0) {
        return
      }

      validateTags(tags)
      await this.awaitStartup('invalidateByTags')
      const keysByTag = await Promise.all(
        tags.map((tag) => this.invalidation.collectKeysForTag(tag, this.invalidationMaxKeys()))
      )
      const keys = mode === 'all' ? this.invalidation.intersectKeys(keysByTag) : [...new Set(keysByTag.flat())]
      this.invalidation.assertWithinInvalidationKeyLimit(keys.length, this.invalidationMaxKeys())

      await this.deleteKeys(keys)
      await this.publishInvalidation({ scope: 'keys', keys, sourceId: this.instanceId, operation: 'invalidate' })
    })
  }

  /**
   * Marks keys associated with any or all of the provided tags as expired while
   * preserving stale windows for stale serving.
   */
  async expireByTags(tags: string[], mode: 'any' | 'all' = 'any'): Promise<void> {
    await this.observeOperation('layercache.expire_by_tags', undefined, async () => {
      if (tags.length === 0) {
        return
      }

      validateTags(tags)
      await this.awaitStartup('expireByTags')
      const keysByTag = await Promise.all(
        tags.map((tag) => this.invalidation.collectKeysForTag(tag, this.invalidationMaxKeys()))
      )
      const keys = mode === 'all' ? this.invalidation.intersectKeys(keysByTag) : [...new Set(keysByTag.flat())]
      this.invalidation.assertWithinInvalidationKeyLimit(keys.length, this.invalidationMaxKeys())

      await this.expireKeys(keys)
      await this.publishInvalidation({ scope: 'keys', keys, sourceId: this.instanceId, operation: 'expire' })
    })
  }

  /**
   * Deletes keys matching a wildcard pattern such as `user:*`.
   */
  async invalidateByPattern(pattern: string): Promise<void> {
    await this.observeOperation('layercache.invalidate_by_pattern', undefined, async () => {
      validatePattern(pattern)
      await this.awaitStartup('invalidateByPattern')
      const keys = await this.keyDiscovery.collectKeysMatchingPattern(
        this.qualifyPattern(pattern),
        this.invalidationMaxKeys()
      )
      await this.deleteKeys(keys)
      await this.publishInvalidation({ scope: 'keys', keys, sourceId: this.instanceId, operation: 'invalidate' })
    })
  }

  /**
   * Marks keys matching a wildcard pattern as expired while preserving stale
   * windows for stale serving.
   */
  async expireByPattern(pattern: string): Promise<void> {
    await this.observeOperation('layercache.expire_by_pattern', undefined, async () => {
      validatePattern(pattern)
      await this.awaitStartup('expireByPattern')
      const keys = await this.keyDiscovery.collectKeysMatchingPattern(
        this.qualifyPattern(pattern),
        this.invalidationMaxKeys()
      )
      await this.expireKeys(keys)
      await this.publishInvalidation({ scope: 'keys', keys, sourceId: this.instanceId, operation: 'expire' })
    })
  }

  /**
   * Deletes keys that start with the provided prefix.
   */
  async invalidateByPrefix(prefix: string): Promise<void> {
    await this.observeOperation('layercache.invalidate_by_prefix', undefined, async () => {
      await this.awaitStartup('invalidateByPrefix')
      const qualifiedPrefix = this.qualifyKey(validateCacheKey(prefix))
      const keys = await this.keyDiscovery.collectKeysWithPrefix(qualifiedPrefix, this.invalidationMaxKeys())
      await this.deleteKeys(keys)
      await this.publishInvalidation({ scope: 'keys', keys, sourceId: this.instanceId, operation: 'invalidate' })
    })
  }

  /**
   * Marks keys that start with the provided prefix as expired while preserving
   * stale windows for stale serving.
   */
  async expireByPrefix(prefix: string): Promise<void> {
    await this.observeOperation('layercache.expire_by_prefix', undefined, async () => {
      await this.awaitStartup('expireByPrefix')
      const qualifiedPrefix = this.qualifyKey(validateCacheKey(prefix))
      const keys = await this.keyDiscovery.collectKeysWithPrefix(qualifiedPrefix, this.invalidationMaxKeys())
      await this.expireKeys(keys)
      await this.publishInvalidation({ scope: 'keys', keys, sourceId: this.instanceId, operation: 'expire' })
    })
  }

  /**
   * Returns cumulative cache metrics since startup or the last `resetMetrics()`.
   */
  getMetrics(): CacheMetricsSnapshot {
    return this.metricsCollector.snapshot
  }

  /**
   * Runs an operation while collecting only the metrics emitted by its async context.
   * Used by namespaces so metrics tracking does not serialize the operation itself.
   */
  async captureMetrics<T>(operation: () => Promise<T>): Promise<{ result: T; metrics: CacheMetricsSnapshot }> {
    return this.metricsCollector.capture(operation)
  }

  /**
   * Returns metrics plus layer degradation state and active background refresh count.
   */
  getStats(): CacheStatsSnapshot {
    return {
      metrics: this.getMetrics(),
      layers: this.layers.map((layer) => ({
        name: layer.name,
        isLocal: Boolean(layer.isLocal),
        degradedUntil: this.layerDegradedUntil.get(layer.name) ?? null
      })),
      backgroundRefreshes: this.reader.activeRefreshCount
    }
  }

  /**
   * Resets cumulative metrics counters.
   */
  resetMetrics(): void {
    this.metricsCollector.reset()
  }

  /**
   * Returns computed hit-rate statistics (overall and per-layer).
   */
  getHitRate(): CacheHitRateSnapshot {
    return this.metricsCollector.hitRate()
  }

  /**
   * Runs each layer's `ping()` hook when available and returns per-layer health
   * and latency information.
   */
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
    const updatedGeneration = nextGeneration ?? current + 1
    const generationToCleanup = resolveGenerationCleanupTarget({
      previousGeneration,
      nextGeneration: updatedGeneration,
      generationCleanup: this.options.generationCleanup
    })

    this.currentGeneration = updatedGeneration
    if (generationToCleanup !== null) {
      this.scheduleGenerationCleanup(generationToCleanup)
    }

    return this.currentGeneration
  }

  /**
   * Returns the active generation prefix number used for future cache keys.
   */
  getGeneration(): number | undefined {
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
    let freshTtlMs: number | null = null
    let staleTtlMs: number | null = null
    let errorTtlMs: number | null = null
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
        freshTtlMs =
          resolved.envelope.freshUntil !== null ? Math.max(0, Math.ceil(resolved.envelope.freshUntil - now)) : null
        staleTtlMs =
          resolved.envelope.staleUntil !== null ? Math.max(0, Math.ceil(resolved.envelope.staleUntil - now)) : null
        errorTtlMs =
          resolved.envelope.errorUntil !== null ? Math.max(0, Math.ceil(resolved.envelope.errorUntil - now)) : null
        isStale = resolved.state === 'stale-while-revalidate' || resolved.state === 'stale-if-error'
      }
    }

    if (foundInLayers.length === 0) {
      return null
    }

    const tags = await this.getTagsForKey(normalizedKey)

    return { key: userKey, foundInLayers, freshTtlMs, staleTtlMs, errorTtlMs, isStale, tags }
  }

  /**
   * Exports cache entries from configured layers for process-local snapshots.
   */
  async exportState(): Promise<CacheSnapshotEntry[]> {
    await this.awaitStartup('exportState')
    return this.snapshots.exportState(this.snapshotMaxEntries())
  }

  /**
   * Imports entries produced by `exportState()` into the configured layers.
   */
  async importState(entries: CacheSnapshotEntry[]): Promise<void> {
    await this.awaitStartup('importState')
    await this.snapshots.importState(entries)
  }

  /**
   * Writes a snapshot file containing current cache entries.
   */
  async persistToFile(filePath: string): Promise<void> {
    this.assertActive('persistToFile')
    await this.snapshots.persistToFile(filePath, this.options.snapshotBaseDir, this.snapshotMaxEntries())
  }

  /**
   * Restores cache entries from a snapshot file.
   */
  async restoreFromFile(filePath: string): Promise<void> {
    this.assertActive('restoreFromFile')
    await this.snapshots.restoreFromFile(filePath, this.options.snapshotBaseDir, this.snapshotMaxBytes())
  }

  /**
   * Flushes background work, unsubscribes from buses, disposes timers, and then
   * disposes each layer that provides `dispose()`.
   */
  async disconnect(): Promise<void> {
    if (!this.disconnectPromise) {
      this.isDisconnecting = true
      this.disconnectPromise = (async () => {
        await this.startup
        await this.unsubscribeInvalidation?.()
        await this.flushWriteBehindQueue()
        await this.maintenance.waitForGenerationCleanup()
        this.reader.abortAllRefreshes()
        await Promise.allSettled(
          this.reader.getAllRefreshPromises().map((promise) => {
            let timer: ReturnType<typeof setTimeout> | undefined
            return Promise.race([
              promise,
              new Promise<void>((resolve) => {
                timer = setTimeout(resolve, 5_000)
                timer.unref?.()
              })
            ]).finally(() => {
              if (timer) clearTimeout(timer)
            })
          })
        )
        this.maintenance.disposeWriteBehindTimer()
        this.fetchRateLimiter.dispose()
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

  private async storeEntry(
    key: string,
    kind: CacheWriteKind,
    value: unknown,
    options?: CacheWriteOptions
  ): Promise<void> {
    const resolvedOptions = this.resolveContextOptions(key, kind, value, options)
    const clearEpoch = this.maintenance.currentClearEpoch()
    const keyEpoch = this.maintenance.currentKeyEpoch(key)
    await this.layerWriter.writeAcrossLayers(key, kind, value, resolvedOptions)
    if (this.maintenance.isWriteOutdated(key, clearEpoch, keyEpoch)) {
      return
    }
    if (resolvedOptions?.tags) {
      await this.tagIndex.track(key, resolvedOptions.tags)
    } else {
      await this.tagIndex.touch(key)
    }

    this.metricsCollector.increment('sets')
    this.logger.debug?.('set', { key, kind, tags: resolvedOptions?.tags })
    this.emit('set', { key, kind: kind as string, tags: resolvedOptions?.tags })
    if (this.shouldBroadcastL1Invalidation()) {
      await this.publishInvalidation({ scope: 'key', keys: [key], sourceId: this.instanceId, operation: 'write' })
    }
  }

  private async writeBatch(
    entries: Array<{ key: string; value: unknown; options?: CacheWriteOptions }>
  ): Promise<void> {
    const resolvedEntries = entries.map((entry) => ({
      ...entry,
      options: this.resolveContextOptions(entry.key, 'value', entry.value, entry.options)
    }))
    const { clearEpoch, entryEpochs } = await this.layerWriter.writeBatch(resolvedEntries)
    if (clearEpoch !== this.maintenance.currentClearEpoch()) {
      return
    }

    for (const entry of resolvedEntries) {
      if (this.maintenance.isWriteOutdated(entry.key, clearEpoch, entryEpochs.get(entry.key))) {
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

  private resolveLayerMs(
    layerName: string,
    override: number | LayerTtlMap | undefined,
    globalDefault?: number | LayerTtlMap,
    fallback?: number
  ): number | undefined {
    return this.ttlResolver.resolveLayerMs(layerName, override, globalDefault, fallback)
  }

  private resolveContextOptions(
    key: string,
    kind: CacheEntryWriteKind,
    value: unknown,
    options: CacheWriteOptions | undefined
  ): CacheWriteOptions | undefined {
    if (!options?.contextOptions) {
      return options
    }

    const { contextOptions, ...baseOptions } = options
    let overrides: CacheEntryWriteOptions | undefined
    try {
      overrides = contextOptions({ key, value, kind } as CacheContextOptionsContext)
    } catch (error) {
      throw new Error(`options.contextOptions() failed for key "${key}": ${this.formatError(error)}`)
    }
    if (!overrides) {
      return baseOptions
    }
    if (!this.isPlainObject(overrides)) {
      throw new Error(
        `options.contextOptions() must return a plain object or undefined for key "${key}". Async resolvers are not supported.`
      )
    }

    try {
      validateContextEntryOptions('options.contextOptions()', overrides)
    } catch (error) {
      throw new Error(
        `options.contextOptions() returned invalid entry options for key "${key}": ${this.formatError(error)}`
      )
    }
    return {
      ...baseOptions,
      ...overrides
    }
  }

  private isPlainObject(value: unknown): value is Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return false
    }

    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null
  }

  private async deleteKeys(keys: string[]): Promise<void> {
    if (keys.length === 0) {
      return
    }

    this.maintenance.bumpKeyEpochs(keys)
    await this.invalidation.deleteKeysFromLayers(this.layers, keys)

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

  private async expireKeys(keys: string[]): Promise<void> {
    if (keys.length === 0) {
      return
    }

    this.maintenance.bumpKeyEpochs(keys)
    const foundKeys = await this.expireKeysInLayers(keys, this.layers)

    for (const key of keys) {
      if (foundKeys.has(key)) {
        continue
      }

      await this.tagIndex.remove(key)
      this.ttlResolver.deleteProfile(key)
      this.circuitBreakerManager.delete(key)
    }

    this.metricsCollector.increment('invalidations')
    this.logger.debug?.('expire', { keys })
    this.emit('expire', { keys })
  }

  private async expireKeysInLayers(keys: string[], layers: CacheLayer[]): Promise<Set<string>> {
    if (keys.length === 0) {
      return new Set()
    }

    return this.invalidation.expireKeysInLayers(layers, keys)
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
      this.maintenance.beginClearEpoch()
      await Promise.all(localLayers.map((layer) => layer.clear()))
      await this.tagIndex.clear()
      this.ttlResolver.clearProfiles()
      this.circuitBreakerManager.clear()
      return
    }

    const keys = message.keys ?? []
    this.maintenance.bumpKeyEpochs(keys)
    if (message.operation === 'expire') {
      await this.expireKeysInLayers(keys, localLayers)
      return
    }

    await this.invalidation.deleteKeysFromLayers(localLayers, keys)

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
      if (result !== null && result !== undefined && typeof result === 'object' && 'kind' in result) {
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

  private async observeOperation<T>(
    name: string,
    attributes: Record<string, unknown> | undefined,
    execute: () => Promise<T>
  ): Promise<T> {
    const id = this.nextOperationId
    this.nextOperationId = (this.nextOperationId + 1) % Number.MAX_SAFE_INTEGER
    this.emit('operation-start', { id, name, attributes })

    try {
      const result = await execute()
      this.emit('operation-end', {
        id,
        name,
        attributes,
        success: true,
        result: result === null ? 'null' : undefined
      })
      return result
    } catch (error) {
      this.emit('operation-end', {
        id,
        name,
        attributes,
        success: false,
        error
      })
      throw error
    }
  }

  private scheduleGenerationCleanup(generation: number): void {
    this.maintenance.scheduleGenerationCleanup(
      generation,
      async (generationToClean) => this.cleanupGeneration(generationToClean),
      (failedGeneration, error) => {
        this.logger.warn?.('generation-cleanup-error', {
          generation: failedGeneration,
          error: this.formatError(error)
        })
      }
    )
  }

  private async cleanupGeneration(generation: number): Promise<void> {
    const prefix = `v${generation}:`
    const keys = await this.keyDiscovery.collectKeysWithPrefix(prefix)
    for (const batch of planGenerationCleanupBatches(keys, this.options.generationCleanup)) {
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
    this.maintenance.initializeWriteBehindTimer(
      this.options.writeStrategy,
      options,
      this.flushWriteBehindQueue.bind(this)
    )
  }

  private shouldWriteBehind(layer: CacheLayer): boolean {
    return this.options.writeStrategy === 'write-behind' && !layer.isLocal
  }

  private async enqueueWriteBehind(operation: () => Promise<void>): Promise<void> {
    await this.maintenance.enqueueWriteBehind(operation, this.options.writeBehind, this.runWriteBehindBatch.bind(this))
  }

  private async flushWriteBehindQueue(): Promise<void> {
    await this.maintenance.flushWriteBehindQueue(this.options.writeBehind, this.runWriteBehindBatch.bind(this))
  }

  private async runWriteBehindBatch(batch: Array<() => Promise<void>>): Promise<void> {
    const results = await Promise.allSettled(batch.map((operation) => operation()))
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (failures.length === 0) {
      return
    }

    this.metricsCollector.increment('writeFailures', failures.length)
    this.logger.error?.('write-behind-flush-failure', {
      failed: failures.length,
      total: batch.length,
      errors: failures.map((failure) => this.formatError(failure.reason))
    })
    this.emitError('write-behind', { failed: failures.length, total: batch.length })
  }

  private qualifyKey(key: string): string {
    return qualifyGenerationKey(key, this.currentGeneration)
  }

  private qualifyPattern(pattern: string): string {
    return qualifyGenerationPattern(pattern, this.currentGeneration)
  }

  private stripQualifiedKey(key: string): string {
    return stripGenerationPrefix(key, this.currentGeneration)
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
    if (options.contextOptions && typeof options.contextOptions !== 'function') {
      throw new Error('options.contextOptions must be a function.')
    }
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

  private async readLayerEntry(layer: CacheLayer, key: string): Promise<unknown | null> {
    return this.reader.readLayerEntry(layer, key)
  }

  private scheduleBackgroundRefresh<T>(
    key: string,
    fetcher: CacheFetcher<T>,
    options?: CacheGetOptions,
    fetcherContext?: CacheFetcherContext<T>
  ): void {
    this.reader.runScheduleBackgroundRefresh(key, fetcher, options, fetcherContext)
  }

  private async applyFreshReadPolicies<T>(
    key: string,
    hit: {
      found: true
      value: T | null
      stored: unknown
      state: 'fresh' | 'stale-while-revalidate' | 'stale-if-error'
      layerIndex: number
      layerName: string
    },
    options: CacheGetOptions | undefined,
    fetcher?: CacheFetcher<T>
  ): Promise<void> {
    return this.reader.runApplyFreshReadPolicies(key, hit, options, fetcher)
  }

  private shouldSkipLayer(layer: CacheLayer): boolean {
    const degradedUntil = this.layerDegradedUntil.get(layer.name)
    const skip = shouldSkipDegradedLayer(degradedUntil)
    if (!skip && degradedUntil !== undefined) {
      this.layerDegradedUntil.delete(layer.name)
    }
    return skip
  }

  private async handleLayerFailure(layer: CacheLayer, operation: string, error: unknown): Promise<null> {
    const recovery = resolveRecoverableLayerFailure(this.options.gracefulDegradation)
    if (!recovery.degrade) {
      throw error
    }

    this.layerDegradedUntil.set(layer.name, recovery.degradedUntil)
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

  private recordCircuitFailure(
    key: string,
    breakerKey: string,
    options: CacheCircuitBreakerOptions | undefined,
    error: unknown
  ): void {
    if (!options) {
      return
    }

    this.circuitBreakerManager.recordFailure(breakerKey, options)
    if (this.circuitBreakerManager.isOpen(breakerKey)) {
      this.metricsCollector.increment('circuitBreakerTrips')
    }
    this.emitError('fetch', { key, breakerKey, error: this.formatError(error) })
  }

  private emitError(operation: string, context: Record<string, unknown>): void {
    this.logger.error?.(operation, context)
    if (this.listenerCount('error') > 0) {
      this.emit('error', { operation, ...context })
    }
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
}
