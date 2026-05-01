import type { StampedeGuard } from '../stampede/StampedeGuard'
import type {
  CacheCircuitBreakerOptions,
  CacheFetcher,
  CacheFetcherContext,
  CacheGetOptions,
  CacheLayer,
  CacheLogger,
  CacheRateLimitOptions,
  CacheSingleFlightCoordinator,
  CacheSingleFlightExecutionOptions,
  CacheStackEvents,
  CacheTagIndex,
  CacheWriteOptions,
  LayerTtlMap
} from '../types'
import type { CacheWriteKind } from './CacheStackLayerWriter'
import type { CacheStackMaintenance } from './CacheStackMaintenance'
import { planFreshReadPolicies, shouldStartBackgroundRefresh } from './CacheStackRuntimePolicy'
import type { CircuitBreakerManager } from './CircuitBreakerManager'
import type { FetchRateLimiter } from './FetchRateLimiter'
import type { MetricsCollector } from './MetricsCollector'
import { isStoredValueEnvelope, remainingStoredTtlMs, resolveStoredValue } from './StoredValue'
import type { TtlResolver } from './TtlResolver'

const DEFAULT_SINGLE_FLIGHT_LEASE_MS = 30_000
const DEFAULT_SINGLE_FLIGHT_TIMEOUT_MS = 5_000
const DEFAULT_SINGLE_FLIGHT_POLL_MS = 50
const DEFAULT_BACKGROUND_REFRESH_TIMEOUT_MS = 30_000

type ReadMode = 'allow-stale' | 'fresh-only'

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

interface CacheStackReaderOptions {
  // Direct service objects
  layers: CacheLayer[]
  metricsCollector: MetricsCollector
  maintenance: CacheStackMaintenance
  tagIndex: CacheTagIndex
  circuitBreakerManager: CircuitBreakerManager
  fetchRateLimiter: FetchRateLimiter
  stampedeGuard: StampedeGuard
  ttlResolver: TtlResolver
  logger: CacheLogger

  // CacheStack method callbacks
  shouldSkipLayer: (layer: CacheLayer) => boolean
  handleLayerFailure: (layer: CacheLayer, operation: string, error: unknown) => Promise<null>
  emit: <K extends keyof CacheStackEvents>(event: K, data: CacheStackEvents[K]) => boolean
  emitError: (operation: string, context: Record<string, unknown>) => void
  formatError: (error: unknown) => string
  storeEntry: (key: string, kind: CacheWriteKind, value: unknown, options?: CacheWriteOptions) => Promise<void>
  recordCircuitFailure: (key: string, options: CacheCircuitBreakerOptions | undefined, error: unknown) => void
  resolveLayerMs: (
    layerName: string,
    override: number | LayerTtlMap | undefined,
    globalDefault?: number | LayerTtlMap,
    fallback?: number
  ) => number | undefined
  sleep: (ms: number) => Promise<void>
  withTimeout: <T>(promise: Promise<T>, timeoutMs: number, createError: () => Error) => Promise<T>
  isDisconnecting: () => boolean
  isGracefulDegradationEnabled: () => boolean
  scheduleBackgroundRefreshDispatch: <T>(
    key: string,
    fetcher: CacheFetcher<T>,
    options?: CacheGetOptions,
    fetcherContext?: CacheFetcherContext<T>
  ) => void

  // Config values
  stampedePrevention?: boolean
  singleFlightCoordinator?: CacheSingleFlightCoordinator
  singleFlightLeaseMs?: number
  singleFlightTimeoutMs?: number
  singleFlightPollMs?: number
  singleFlightRenewIntervalMs?: number
  backgroundRefreshTimeoutMs?: number
  negativeCaching?: boolean
  refreshAhead?: number | LayerTtlMap
  circuitBreaker?: CacheCircuitBreakerOptions
  fetcherRateLimit?: CacheRateLimitOptions
}

export class CacheStackReader {
  private readonly backgroundRefreshes = new Map<string, Promise<void>>()
  private readonly backgroundRefreshAbort = new Map<string, boolean>()

  constructor(private readonly options: CacheStackReaderOptions) {}

  get activeRefreshCount(): number {
    return this.backgroundRefreshes.size
  }

  async getPrepared<T>(normalizedKey: string, fetcher?: CacheFetcher<T>, options?: CacheGetOptions): Promise<T | null> {
    const hit = await this.readFromLayers<T>(normalizedKey, options, 'allow-stale')
    if (hit.found) {
      this.options.ttlResolver.recordAccess(normalizedKey)
      if (this.isNegativeStoredValue(hit.stored)) {
        this.options.metricsCollector.increment('negativeCacheHits')
      }

      if (hit.state === 'fresh') {
        this.options.metricsCollector.increment('hits')
        await this.applyFreshReadPolicies(normalizedKey, hit, options, fetcher)
        return hit.value
      }

      if (hit.state === 'stale-while-revalidate') {
        this.options.metricsCollector.increment('hits')
        this.options.metricsCollector.increment('staleHits')
        this.options.emit('stale-serve', { key: normalizedKey, state: hit.state, layer: hit.layerName })
        if (fetcher) {
          this.scheduleBackgroundRefresh(normalizedKey, fetcher, options, this.createFetcherContext(normalizedKey, hit))
        }
        return hit.value
      }

      if (!fetcher) {
        this.options.metricsCollector.increment('hits')
        this.options.metricsCollector.increment('staleHits')
        this.options.emit('stale-serve', { key: normalizedKey, state: hit.state, layer: hit.layerName })
        return hit.value
      }

      try {
        return await this.fetchWithGuards(
          normalizedKey,
          fetcher,
          options,
          undefined,
          undefined,
          false,
          this.createFetcherContext(normalizedKey, hit)
        )
      } catch (error) {
        this.options.metricsCollector.increment('staleHits')
        this.options.metricsCollector.increment('refreshErrors')
        this.options.logger.debug?.('stale-if-error', {
          key: normalizedKey,
          error: this.options.formatError(error)
        })
        return hit.value
      }
    }

    this.options.metricsCollector.increment('misses')
    if (!fetcher) {
      return null
    }

    return this.fetchWithGuards(normalizedKey, fetcher, options, undefined, undefined, true, {
      key: normalizedKey,
      currentValue: undefined,
      state: 'miss'
    })
  }

  async readLayerEntry(layer: CacheLayer, key: string): Promise<unknown | null> {
    if (this.options.shouldSkipLayer(layer)) {
      return null
    }

    if (layer.getEntry) {
      try {
        return await layer.getEntry(key)
      } catch (error) {
        return this.options.handleLayerFailure(layer, 'read', error)
      }
    }

    try {
      return await layer.get(key)
    } catch (error) {
      return this.options.handleLayerFailure(layer, 'read', error)
    }
  }

  async backfill(key: string, stored: unknown, upToIndex: number, options?: CacheGetOptions): Promise<void> {
    if (upToIndex < 0) {
      return
    }

    for (let index = 0; index <= upToIndex; index += 1) {
      const layer = this.options.layers[index]
      if (!layer || this.options.shouldSkipLayer(layer)) {
        continue
      }

      const ttl =
        remainingStoredTtlMs(stored) ??
        this.options.resolveLayerMs(layer.name, options?.ttl, undefined, layer.defaultTtl)
      try {
        await layer.set(key, stored, ttl)
      } catch (error) {
        await this.options.handleLayerFailure(layer, 'backfill', error)
        continue
      }
      this.options.metricsCollector.increment('backfills')
      this.options.logger.debug?.('backfill', { key, layer: layer.name })
      this.options.emit('backfill', { key, layer: layer.name })
    }
  }

  abortAllRefreshes(): void {
    for (const key of this.backgroundRefreshAbort.keys()) {
      this.backgroundRefreshAbort.set(key, true)
    }
  }

  getAllRefreshPromises(): Promise<void>[] {
    return [...this.backgroundRefreshes.values()]
  }

  private async readFromLayers<T>(
    key: string,
    options: CacheGetOptions | undefined,
    mode: ReadMode
  ): Promise<ReadHit<T>> {
    let sawRetainableValue = false

    for (let index = 0; index < this.options.layers.length; index += 1) {
      const layer = this.options.layers[index]
      if (!layer) continue
      const readStart = performance.now()
      const stored = await this.readLayerEntry(layer, key)
      const readDuration = performance.now() - readStart
      this.options.metricsCollector.recordLatency(layer.name, readDuration)
      if (stored === null) {
        this.options.metricsCollector.incrementLayer('missesByLayer', layer.name)
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

      await this.options.tagIndex.touch(key)
      await this.backfill(key, stored, index - 1, options)
      this.options.metricsCollector.incrementLayer('hitsByLayer', layer.name)
      this.options.logger.debug?.('hit', { key, layer: layer.name, state: resolved.state })
      this.options.emit('hit', {
        key,
        layer: layer.name,
        state: resolved.state as CacheStackEvents['hit']['state']
      })
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
      await this.options.tagIndex.remove(key)
    }

    this.options.logger.debug?.('miss', { key, mode })
    this.options.emit('miss', { key, mode })
    return { found: false, value: null, stored: null, state: 'miss' }
  }

  private async fetchWithGuards<T>(
    key: string,
    fetcher: CacheFetcher<T>,
    options?: CacheGetOptions,
    expectedClearEpoch?: number,
    expectedKeyEpoch?: number,
    initialMissConfirmed = false,
    fetcherContext: CacheFetcherContext<T> = {
      key,
      currentValue: undefined,
      state: 'miss'
    }
  ): Promise<T | null> {
    const fetchTask = async (): Promise<T | null> => {
      const shouldRecheckFreshLayers = !(initialMissConfirmed && this.options.singleFlightCoordinator)
      if (shouldRecheckFreshLayers) {
        const secondHit = await this.readFromLayers<T>(key, options, 'fresh-only')
        if (secondHit.found) {
          this.options.metricsCollector.increment('hits')
          return secondHit.value
        }
      }

      return this.fetchAndPopulate(key, fetcher, options, expectedClearEpoch, expectedKeyEpoch, fetcherContext)
    }

    const singleFlightTask = async (): Promise<T | null> => {
      if (!this.options.singleFlightCoordinator) {
        return fetchTask()
      }

      try {
        return await this.options.singleFlightCoordinator.execute(
          key,
          this.resolveSingleFlightOptions(),
          fetchTask,
          () => this.waitForFreshValue(key, fetcher, options, expectedClearEpoch, expectedKeyEpoch, fetcherContext)
        )
      } catch (error) {
        if (!this.options.isGracefulDegradationEnabled()) {
          throw error
        }

        this.options.metricsCollector.increment('degradedOperations')
        this.options.logger.warn?.('single-flight-coordinator-degraded', {
          key,
          error: this.options.formatError(error)
        })
        this.options.emitError('single-flight', {
          key,
          degraded: true,
          error: this.options.formatError(error)
        })
        return fetchTask()
      }
    }

    if (this.options.stampedePrevention === false) {
      return singleFlightTask()
    }

    return this.options.stampedeGuard.execute(key, singleFlightTask)
  }

  private async waitForFreshValue<T>(
    key: string,
    fetcher: CacheFetcher<T>,
    options?: CacheGetOptions,
    expectedClearEpoch?: number,
    expectedKeyEpoch?: number,
    fetcherContext: CacheFetcherContext<T> = {
      key,
      currentValue: undefined,
      state: 'miss'
    }
  ): Promise<T | null> {
    const timeoutMs = this.options.singleFlightTimeoutMs ?? DEFAULT_SINGLE_FLIGHT_TIMEOUT_MS
    const pollIntervalMs = this.options.singleFlightPollMs ?? DEFAULT_SINGLE_FLIGHT_POLL_MS
    const deadline = Date.now() + timeoutMs

    this.options.metricsCollector.increment('singleFlightWaits')
    this.options.emit('stampede-dedupe', { key })

    while (Date.now() < deadline) {
      const hit = await this.readFromLayers<T>(key, options, 'fresh-only')
      if (hit.found) {
        this.options.metricsCollector.increment('hits')
        return hit.value
      }
      await this.options.sleep(pollIntervalMs)
    }

    return this.fetchAndPopulate(key, fetcher, options, expectedClearEpoch, expectedKeyEpoch, fetcherContext)
  }

  private async fetchAndPopulate<T>(
    key: string,
    fetcher: CacheFetcher<T>,
    options?: CacheGetOptions,
    expectedClearEpoch?: number,
    expectedKeyEpoch?: number,
    fetcherContext: CacheFetcherContext<T> = {
      key,
      currentValue: undefined,
      state: 'miss'
    }
  ): Promise<T | null> {
    this.options.circuitBreakerManager.assertClosed(key, options?.circuitBreaker ?? this.options.circuitBreaker)
    this.options.metricsCollector.increment('fetches')
    const fetchStart = Date.now()
    let fetched: T

    try {
      fetched = await this.options.fetchRateLimiter.schedule(
        options?.fetcherRateLimit ?? this.options.fetcherRateLimit,
        { key, fetcher },
        () => fetcher(fetcherContext)
      )
      this.options.circuitBreakerManager.recordSuccess(key)
      this.options.logger.debug?.('fetch', { key, durationMs: Date.now() - fetchStart })
    } catch (error) {
      this.options.recordCircuitFailure(key, options?.circuitBreaker ?? this.options.circuitBreaker, error)
      throw error
    }

    if (fetched === null || fetched === undefined) {
      if (!this.shouldNegativeCache(options)) {
        return null
      }

      if (this.options.maintenance.isWriteOutdated(key, expectedClearEpoch, expectedKeyEpoch)) {
        this.options.logger.debug?.('skip-negative-store-after-invalidation', {
          key,
          expectedClearEpoch,
          clearEpoch: this.options.maintenance.currentClearEpoch(),
          expectedKeyEpoch,
          keyEpoch: this.options.maintenance.currentKeyEpoch(key)
        })
        return null
      }

      await this.options.storeEntry(key, 'empty', null, options)
      return null
    }

    // Conditional caching: skip storage if shouldCache returns false
    if (options?.shouldCache) {
      try {
        if (!options.shouldCache(fetched)) {
          return fetched
        }
      } catch (error) {
        this.options.logger.warn?.('shouldCache-error', {
          key,
          error: this.options.formatError(error)
        })
      }
    }

    if (this.options.maintenance.isWriteOutdated(key, expectedClearEpoch, expectedKeyEpoch)) {
      this.options.logger.debug?.('skip-store-after-invalidation', {
        key,
        expectedClearEpoch,
        clearEpoch: this.options.maintenance.currentClearEpoch(),
        expectedKeyEpoch,
        keyEpoch: this.options.maintenance.currentKeyEpoch(key)
      })
      return fetched
    }

    await this.options.storeEntry(key, 'value', fetched, options)
    return fetched
  }

  runScheduleBackgroundRefresh<T>(
    key: string,
    fetcher: CacheFetcher<T>,
    options?: CacheGetOptions,
    fetcherContext?: CacheFetcherContext<T>
  ): void {
    this.scheduleBackgroundRefresh(key, fetcher, options, fetcherContext)
  }

  private scheduleBackgroundRefresh<T>(
    key: string,
    fetcher: CacheFetcher<T>,
    options?: CacheGetOptions,
    fetcherContext: CacheFetcherContext<T> = {
      key,
      currentValue: undefined,
      state: 'miss'
    }
  ): void {
    if (
      !shouldStartBackgroundRefresh({
        isDisconnecting: this.options.isDisconnecting(),
        hasRefreshInFlight: this.backgroundRefreshes.has(key)
      })
    ) {
      return
    }

    const clearEpoch = this.options.maintenance.currentClearEpoch()
    const keyEpoch = this.options.maintenance.currentKeyEpoch(key)
    this.backgroundRefreshAbort.set(key, false)
    const refresh = (async () => {
      this.options.metricsCollector.increment('refreshes')
      try {
        if (this.backgroundRefreshAbort.get(key)) return
        await this.runBackgroundRefresh(key, fetcher, options, clearEpoch, keyEpoch, fetcherContext)
      } catch (error) {
        if (this.backgroundRefreshAbort.get(key)) return
        this.options.metricsCollector.increment('refreshErrors')
        this.options.logger.warn?.('background-refresh-error', {
          key,
          error: this.options.formatError(error)
        })
      } finally {
        this.backgroundRefreshes.delete(key)
        this.backgroundRefreshAbort.delete(key)
      }
    })()

    this.backgroundRefreshes.set(key, refresh)
  }

  private async runBackgroundRefresh<T>(
    key: string,
    fetcher: CacheFetcher<T>,
    options?: CacheGetOptions,
    expectedClearEpoch?: number,
    expectedKeyEpoch?: number,
    fetcherContext: CacheFetcherContext<T> = {
      key,
      currentValue: undefined,
      state: 'miss'
    }
  ): Promise<void> {
    const timeoutMs = this.options.backgroundRefreshTimeoutMs ?? DEFAULT_BACKGROUND_REFRESH_TIMEOUT_MS
    await this.fetchWithGuards(
      key,
      (context) =>
        this.options.withTimeout(fetcher(context), timeoutMs, () => {
          return new Error(`Background refresh timed out after ${timeoutMs}ms for key "${key}".`)
        }),
      options,
      expectedClearEpoch,
      expectedKeyEpoch,
      false,
      fetcherContext
    )
  }

  async runApplyFreshReadPolicies<T>(
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
    return this.applyFreshReadPolicies(key, hit as Extract<ReadHit<T>, { found: true }>, options, fetcher)
  }

  private async applyFreshReadPolicies<T>(
    key: string,
    hit: Extract<ReadHit<T>, { found: true }>,
    options: CacheGetOptions | undefined,
    fetcher?: CacheFetcher<T>
  ): Promise<void> {
    const plan = planFreshReadPolicies({
      stored: hit.stored,
      hasFetcher: Boolean(fetcher),
      slidingTtl: options?.slidingTtl ?? false,
      refreshAheadMs:
        this.options.resolveLayerMs(hit.layerName, options?.refreshAhead, this.options.refreshAhead, 0) ?? 0
    })

    if (plan.refreshedStored) {
      for (let index = 0; index <= hit.layerIndex; index += 1) {
        const layer = this.options.layers[index]
        if (!layer || this.options.shouldSkipLayer(layer)) {
          continue
        }

        try {
          await layer.set(key, plan.refreshedStored, plan.refreshedStoredTtl)
        } catch (error) {
          await this.options.handleLayerFailure(layer, 'sliding-ttl', error)
        }
      }
    }

    if (fetcher && plan.shouldScheduleBackgroundRefresh) {
      this.options.scheduleBackgroundRefreshDispatch(key, fetcher, options, this.createFetcherContext(key, hit))
    }
  }

  private createFetcherContext<T>(key: string, hit: Extract<ReadHit<T>, { found: true }>): CacheFetcherContext<T> {
    return {
      key,
      currentValue: hit.value === null ? undefined : hit.value,
      state: hit.state,
      layer: hit.layerName
    }
  }

  private resolveSingleFlightOptions(): CacheSingleFlightExecutionOptions {
    return {
      leaseMs: this.options.singleFlightLeaseMs ?? DEFAULT_SINGLE_FLIGHT_LEASE_MS,
      waitTimeoutMs: this.options.singleFlightTimeoutMs ?? DEFAULT_SINGLE_FLIGHT_TIMEOUT_MS,
      pollIntervalMs: this.options.singleFlightPollMs ?? DEFAULT_SINGLE_FLIGHT_POLL_MS,
      renewIntervalMs: this.options.singleFlightRenewIntervalMs
    }
  }

  private shouldNegativeCache(options?: CacheGetOptions): boolean {
    return options?.negativeCache ?? this.options.negativeCaching ?? false
  }

  private isNegativeStoredValue(stored: unknown): boolean {
    return isStoredValueEnvelope(stored) && stored.kind === 'empty'
  }
}
