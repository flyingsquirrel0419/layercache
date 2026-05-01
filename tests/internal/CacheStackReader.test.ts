import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CacheWriteKind } from '../../src/internal/CacheStackLayerWriter'
import { CacheStackMaintenance } from '../../src/internal/CacheStackMaintenance'
import { CacheStackReader } from '../../src/internal/CacheStackReader'
import { CircuitBreakerManager } from '../../src/internal/CircuitBreakerManager'
import { FetchRateLimiter } from '../../src/internal/FetchRateLimiter'
import { MetricsCollector } from '../../src/internal/MetricsCollector'
import { createStoredValueEnvelope } from '../../src/internal/StoredValue'
import { TtlResolver } from '../../src/internal/TtlResolver'
import { TagIndex } from '../../src/invalidation/TagIndex'
import { StampedeGuard } from '../../src/stampede/StampedeGuard'
import type { CacheFetcherContext, CacheGetOptions, CacheLayer } from '../../src/types'

// --- Mock helpers ---

function createMockLayer(name: string, overrides: Partial<CacheLayer> = {}): CacheLayer {
  return {
    name,
    get: vi.fn(async () => null),
    set: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
    clear: vi.fn(async () => {}),
    isLocal: true,
    ...overrides
  }
}

interface MockOptions {
  layers: CacheLayer[]
  metricsCollector: MetricsCollector
  maintenance: CacheStackMaintenance
  tagIndex: TagIndex
  circuitBreakerManager: CircuitBreakerManager
  fetchRateLimiter: FetchRateLimiter
  stampedeGuard: StampedeGuard
  ttlResolver: TtlResolver
  logger: {
    debug: ReturnType<typeof vi.fn>
    info: ReturnType<typeof vi.fn>
    warn: ReturnType<typeof vi.fn>
    error: ReturnType<typeof vi.fn>
  }
  shouldSkipLayer: ReturnType<typeof vi.fn>
  handleLayerFailure: ReturnType<typeof vi.fn>
  emit: ReturnType<typeof vi.fn>
  emitError: ReturnType<typeof vi.fn>
  formatError: ReturnType<typeof vi.fn>
  storeEntry: ReturnType<typeof vi.fn>
  recordCircuitFailure: ReturnType<typeof vi.fn>
  resolveLayerMs: ReturnType<typeof vi.fn>
  sleep: ReturnType<typeof vi.fn>
  withTimeout: ReturnType<typeof vi.fn>
  isDisconnecting: ReturnType<typeof vi.fn>
  isGracefulDegradationEnabled: ReturnType<typeof vi.fn>
  scheduleBackgroundRefreshDispatch: ReturnType<typeof vi.fn>
  stampedePrevention?: boolean
  singleFlightCoordinator?: unknown
  singleFlightLeaseMs?: number
  singleFlightTimeoutMs?: number
  singleFlightPollMs?: number
  singleFlightRenewIntervalMs?: number
  backgroundRefreshTimeoutMs?: number
  negativeCaching?: boolean
  refreshAhead?: number
  circuitBreaker?: unknown
  fetcherRateLimit?: unknown
}

function createMockOptions(overrides: Partial<MockOptions> = {}): MockOptions {
  return {
    layers: [],
    metricsCollector: new MetricsCollector(),
    maintenance: new CacheStackMaintenance(),
    tagIndex: new TagIndex(),
    circuitBreakerManager: new CircuitBreakerManager({ maxEntries: 100 }),
    fetchRateLimiter: new FetchRateLimiter(),
    stampedeGuard: new StampedeGuard(),
    ttlResolver: new TtlResolver({ maxProfileEntries: 100 }),
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    shouldSkipLayer: vi.fn(() => false),
    handleLayerFailure: vi.fn(async () => null),
    emit: vi.fn(() => true),
    emitError: vi.fn(),
    formatError: vi.fn((e: unknown) => String(e)),
    storeEntry: vi.fn(async () => {}),
    recordCircuitFailure: vi.fn(),
    resolveLayerMs: vi.fn(() => undefined),
    sleep: vi.fn(async () => {}),
    withTimeout: vi.fn(async <T>(promise: Promise<T>) => promise),
    isDisconnecting: vi.fn(() => false),
    isGracefulDegradationEnabled: vi.fn(() => false),
    scheduleBackgroundRefreshDispatch: vi.fn(),
    ...overrides
  }
}

function createReader(overrides: Partial<MockOptions> = {}): {
  reader: CacheStackReader
  options: MockOptions
} {
  const options = createMockOptions(overrides)
  const reader = new CacheStackReader(options as unknown as ConstructorParameters<typeof CacheStackReader>[0])
  return { reader, options }
}

describe('CacheStackReader', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  // --- readLayerEntry ---

  describe('readLayerEntry', () => {
    it('returns null when layer is skipped', async () => {
      const { reader, options } = createReader()
      const layer = createMockLayer('L1')
      options.shouldSkipLayer.mockReturnValue(true)

      const result = await reader.readLayerEntry(layer, 'key:1')
      expect(result).toBeNull()
      expect(layer.get).not.toHaveBeenCalled()
    })

    it('returns raw value when layer has no getEntry (uses get)', async () => {
      const { reader } = createReader()
      const layer = createMockLayer('L1', {
        get: vi.fn(async () => 'plain-value')
      })

      const result = await reader.readLayerEntry(layer, 'key:1')
      expect(result).toBe('plain-value')
    })

    it('returns getEntry value when available', async () => {
      const { reader } = createReader()
      const envelope = createStoredValueEnvelope({ kind: 'value', value: 'envelope-value', freshTtlMs: 60_000 })
      const layer = createMockLayer('L1', {
        getEntry: vi.fn(async () => envelope)
      })

      const result = await reader.readLayerEntry(layer, 'key:1')
      expect(result).toBe(envelope)
      expect(layer.get).not.toHaveBeenCalled()
    })

    it('calls handleLayerFailure and returns null on read error', async () => {
      const { reader, options } = createReader()
      const error = new Error('read fail')
      const layer = createMockLayer('L1', {
        get: vi.fn(async () => {
          throw error
        })
      })

      const result = await reader.readLayerEntry(layer, 'key:1')
      expect(result).toBeNull()
      expect(options.handleLayerFailure).toHaveBeenCalledWith(layer, 'read', error)
    })
  })

  // --- backfill ---

  describe('backfill', () => {
    it('does nothing when upToIndex < 0', async () => {
      const { reader, options } = createReader()
      const layer = createMockLayer('L1')
      options.layers = [layer]

      await reader.backfill('key:1', 'stored', -1)
      expect(layer.set).not.toHaveBeenCalled()
    })

    it('skips degraded layers', async () => {
      const { reader, options } = createReader()
      const layer0 = createMockLayer('L0')
      const layer1 = createMockLayer('L1')
      options.layers = [layer0, layer1]
      options.shouldSkipLayer.mockImplementation((l: CacheLayer) => l.name === 'L0')

      await reader.backfill('key:1', 'stored', 1)
      expect(layer0.set).not.toHaveBeenCalled()
      expect(layer1.set).toHaveBeenCalledWith('key:1', 'stored', undefined)
    })

    it('sets value on each layer from 0 to upToIndex', async () => {
      const { reader, options } = createReader()
      const layer0 = createMockLayer('L0')
      const layer1 = createMockLayer('L1')
      const layer2 = createMockLayer('L2')
      options.layers = [layer0, layer1, layer2]
      options.resolveLayerMs.mockReturnValue(60_000)

      await reader.backfill('key:1', 'stored', 1)
      expect(layer0.set).toHaveBeenCalledWith('key:1', 'stored', 60_000)
      expect(layer1.set).toHaveBeenCalledWith('key:1', 'stored', 60_000)
      expect(layer2.set).not.toHaveBeenCalled()
    })

    it('handles layer.set error gracefully (calls handleLayerFailure)', async () => {
      const { reader, options } = createReader()
      const error = new Error('set fail')
      const layer0 = createMockLayer('L0', {
        set: vi.fn(async () => {
          throw error
        })
      })
      const layer1 = createMockLayer('L1')
      options.layers = [layer0, layer1]
      options.resolveLayerMs.mockReturnValue(60_000)

      await reader.backfill('key:1', 'stored', 1)
      expect(options.handleLayerFailure).toHaveBeenCalledWith(layer0, 'backfill', error)
      expect(layer1.set).toHaveBeenCalled()
    })

    it('increments backfill metrics and emits backfill event per layer', async () => {
      const { reader, options } = createReader()
      const layer0 = createMockLayer('L0')
      options.layers = [layer0]
      options.resolveLayerMs.mockReturnValue(30_000)

      await reader.backfill('key:1', 'stored', 0)
      expect(options.metricsCollector.snapshot.backfills).toBe(1)
      expect(options.emit).toHaveBeenCalledWith('backfill', { key: 'key:1', layer: 'L0' })
    })
  })

  // --- readFromLayers (tested via getPrepared which calls it) ---

  describe('readFromLayers', () => {
    it('skips sparse layer slots while reading', async () => {
      const { reader, options } = createReader()
      options.layers = [undefined as unknown as CacheLayer, createMockLayer('L1')]

      const result = await reader.getPrepared('key:1')
      expect(result).toBeNull()
      expect(options.metricsCollector.snapshot.misses).toBe(1)
    })

    it('returns miss when all layers return null', async () => {
      const { reader, options } = createReader()
      options.layers = [createMockLayer('L0'), createMockLayer('L1')]

      const result = await reader.getPrepared('key:1')
      expect(result).toBeNull()
      expect(options.metricsCollector.snapshot.misses).toBe(1)
    })

    it('returns fresh hit from first layer with value', async () => {
      const { reader, options } = createReader()
      const envelope = createStoredValueEnvelope({ kind: 'value', value: 'hello', freshTtlMs: 60 })
      options.layers = [createMockLayer('L0', { get: vi.fn(async () => envelope) }), createMockLayer('L1')]

      const result = await reader.getPrepared('key:1')
      expect(result).toBe('hello')
      expect(options.metricsCollector.snapshot.hits).toBe(1)
    })

    it('falls through to second layer on miss from first', async () => {
      const { reader, options } = createReader()
      const envelope = createStoredValueEnvelope({ kind: 'value', value: 'from-L1', freshTtlMs: 60 })
      options.layers = [
        createMockLayer('L0', { get: vi.fn(async () => null) }),
        createMockLayer('L1', { get: vi.fn(async () => envelope) })
      ]

      const result = await reader.getPrepared('key:1')
      expect(result).toBe('from-L1')
      expect(options.metricsCollector.snapshot.hits).toBe(1)
    })

    it('skips expired values (deletes them)', async () => {
      const { reader, options } = createReader()
      const expired = createStoredValueEnvelope({
        kind: 'value',
        value: 'old',
        freshTtlMs: 1_000,
        staleWhileRevalidateMs: 1_000,
        staleIfErrorMs: 1_000,
        now: Date.now() - 5_000
      })
      options.layers = [createMockLayer('L0', { get: vi.fn(async () => expired) })]

      const result = await reader.getPrepared('key:1')
      expect(result).toBeNull()
      expect(options.metricsCollector.snapshot.misses).toBe(1)
    })

    it('removes tag index entry when no retainable value found', async () => {
      const { reader, options } = createReader()
      const expired = createStoredValueEnvelope({
        kind: 'value',
        value: 'expired',
        freshTtlMs: 1_000,
        staleWhileRevalidateMs: 1_000,
        staleIfErrorMs: 1_000,
        now: Date.now() - 5_000
      })
      const removeSpy = vi.spyOn(options.tagIndex, 'remove')
      options.layers = [createMockLayer('L0', { get: vi.fn(async () => expired) })]

      await reader.getPrepared('key:1')
      expect(removeSpy).toHaveBeenCalledWith('key:1')
    })

    it('records latency per layer', async () => {
      const { reader, options } = createReader()
      options.layers = [
        createMockLayer('L0', { get: vi.fn(async () => null) }),
        createMockLayer('L1', { get: vi.fn(async () => 'hit') })
      ]

      await reader.getPrepared('key:1')
      const snapshot = options.metricsCollector.snapshot
      expect(snapshot.latencyByLayer.L0).toBeDefined()
      expect(snapshot.latencyByLayer.L0.count).toBe(1)
      expect(snapshot.latencyByLayer.L1.count).toBe(1)
    })
  })

  // --- getPrepared — fresh hit path ---

  describe('getPrepared — fresh hit path', () => {
    it('returns cached value on fresh hit, increments hits', async () => {
      const { reader, options } = createReader()
      const envelope = createStoredValueEnvelope({ kind: 'value', value: 42, freshTtlMs: 60 })
      options.layers = [createMockLayer('L0', { get: vi.fn(async () => envelope) })]

      const result = await reader.getPrepared('key:1')
      expect(result).toBe(42)
      expect(options.metricsCollector.snapshot.hits).toBe(1)
    })

    it('records access via ttlResolver', async () => {
      const { reader, options } = createReader()
      const envelope = createStoredValueEnvelope({ kind: 'value', value: 'data', freshTtlMs: 60 })
      options.layers = [createMockLayer('L0', { get: vi.fn(async () => envelope) })]
      const spy = vi.spyOn(options.ttlResolver, 'recordAccess')

      await reader.getPrepared('key:1')
      expect(spy).toHaveBeenCalledWith('key:1')
    })

    it('applies fresh read policies (sliding TTL)', async () => {
      const { reader, options } = createReader()
      const envelope = createStoredValueEnvelope({ kind: 'value', value: 'sliding', freshTtlMs: 60 })
      const layer = createMockLayer('L0', { get: vi.fn(async () => envelope) })
      options.layers = [layer]

      await reader.getPrepared<string>('key:1', undefined, { slidingTtl: true })
      // Sliding TTL writes refreshed envelope back to layers up to hit index
      expect(layer.set).toHaveBeenCalled()
    })
  })

  // --- getPrepared — stale paths ---

  describe('getPrepared — stale paths', () => {
    it('stale-while-revalidate: returns value, schedules background refresh if fetcher exists', async () => {
      const { reader, options } = createReader()
      const stale = createStoredValueEnvelope({
        kind: 'value',
        value: 'stale-data',
        freshTtlMs: 1_000,
        staleWhileRevalidateMs: 60_000,
        now: Date.now() - 2_000
      })
      options.layers = [createMockLayer('L0', { get: vi.fn(async () => stale) })]
      const fetcher = vi.fn(async () => 'fresh-data')

      const result = await reader.getPrepared('key:1', fetcher)
      expect(result).toBe('stale-data')
      expect(options.metricsCollector.snapshot.hits).toBe(1)
      expect(options.metricsCollector.snapshot.staleHits).toBe(1)
      expect(options.emit).toHaveBeenCalledWith('stale-serve', expect.objectContaining({ key: 'key:1' }))
    })

    it('stale-while-revalidate passes stale fetcher context to background refresh', async () => {
      const { reader, options } = createReader()
      const stale = createStoredValueEnvelope({
        kind: 'value',
        value: 'stale-data',
        freshTtlMs: 1_000,
        staleWhileRevalidateMs: 60_000,
        now: Date.now() - 2_000
      })
      options.layers = [createMockLayer('L0', { get: vi.fn(async () => stale) })]
      const fetcher = vi.fn(async () => 'fresh-data')

      await reader.getPrepared('key:1', fetcher)
      await Promise.all(reader.getAllRefreshPromises())

      expect(fetcher).toHaveBeenCalledWith({
        key: 'key:1',
        currentValue: 'stale-data',
        state: 'stale-while-revalidate',
        layer: 'L0'
      })
    })

    it('stale-while-revalidate without fetcher: returns value, no refresh', async () => {
      const { reader, options } = createReader()
      const stale = createStoredValueEnvelope({
        kind: 'value',
        value: 'stale-no-fetcher',
        freshTtlMs: 1_000,
        staleWhileRevalidateMs: 60_000,
        now: Date.now() - 2_000
      })
      options.layers = [createMockLayer('L0', { get: vi.fn(async () => stale) })]

      const result = await reader.getPrepared('key:1')
      expect(result).toBe('stale-no-fetcher')
      expect(options.metricsCollector.snapshot.staleHits).toBe(1)
    })

    it('stale-if-error with fetcher: fetches new value, returns it on success', async () => {
      const { reader, options } = createReader()
      const staleIfError = createStoredValueEnvelope({
        kind: 'value',
        value: 'stale-for-error',
        freshTtlMs: 1_000,
        staleIfErrorMs: 300_000,
        now: Date.now() - 2_000
      })
      // staleWhileRevalidateMs also needed so that staleUntil < now but errorUntil > now
      options.layers = [createMockLayer('L0', { get: vi.fn(async () => staleIfError) })]
      const fetcher = vi.fn(async () => 'new-value')
      options.storeEntry = vi.fn(async () => {})

      const result = await reader.getPrepared('key:1', fetcher)
      expect(result).toBe('new-value')
      expect(fetcher).toHaveBeenCalledWith({
        key: 'key:1',
        currentValue: 'stale-for-error',
        state: 'stale-if-error',
        layer: 'L0'
      })
    })

    it('stale-if-error with fetcher error: returns stale value, logs error', async () => {
      const { reader, options } = createReader()
      const staleIfError = createStoredValueEnvelope({
        kind: 'value',
        value: 'stale-safe',
        freshTtlMs: 1_000,
        staleIfErrorMs: 300_000,
        now: Date.now() - 2_000
      })
      options.layers = [createMockLayer('L0', { get: vi.fn(async () => staleIfError) })]
      const fetcher = vi.fn(async () => {
        throw new Error('fetch fail')
      })

      const result = await reader.getPrepared('key:1', fetcher)
      expect(result).toBe('stale-safe')
      expect(options.metricsCollector.snapshot.refreshErrors).toBe(1)
      expect(options.logger.debug).toHaveBeenCalledWith('stale-if-error', expect.objectContaining({ key: 'key:1' }))
    })
  })

  // --- getPrepared — miss path ---

  describe('getPrepared — miss path', () => {
    it('returns null on miss without fetcher', async () => {
      const { reader, options } = createReader()
      options.layers = [createMockLayer('L0')]

      const result = await reader.getPrepared('key:1')
      expect(result).toBeNull()
      expect(options.metricsCollector.snapshot.misses).toBe(1)
    })

    it('fetches and stores value on miss with fetcher', async () => {
      const { reader, options } = createReader()
      options.layers = [createMockLayer('L0')]
      const fetcher = vi.fn(async () => 'fetched')
      options.storeEntry = vi.fn(async () => {})

      const result = await reader.getPrepared('key:1', fetcher)
      expect(result).toBe('fetched')
      expect(options.storeEntry).toHaveBeenCalledWith('key:1', 'value', 'fetched', undefined)
      expect(fetcher).toHaveBeenCalledWith({
        key: 'key:1',
        currentValue: undefined,
        state: 'miss'
      })
    })

    it('increments misses metric on miss', async () => {
      const { reader, options } = createReader()
      options.layers = [createMockLayer('L0')]

      await reader.getPrepared('key:1')
      expect(options.metricsCollector.snapshot.misses).toBe(1)
    })
  })

  // --- fetchAndPopulate (tested via getPrepared miss + fetcher) ---

  describe('fetchAndPopulate', () => {
    it('successful fetch stores value via storeEntry callback', async () => {
      const { reader, options } = createReader()
      options.layers = [createMockLayer('L0')]
      options.storeEntry = vi.fn(async () => {})
      const fetcher = vi.fn(async () => ({ name: 'test' }))

      const result = await reader.getPrepared('key:1', fetcher)
      expect(result).toEqual({ name: 'test' })
      expect(options.storeEntry).toHaveBeenCalledWith('key:1', 'value', { name: 'test' }, undefined)
    })

    it('null fetch result returns null without negative caching', async () => {
      const { reader, options } = createReader()
      options.layers = [createMockLayer('L0')]
      options.storeEntry = vi.fn(async () => {})
      const fetcher = vi.fn(async () => null)

      const result = await reader.getPrepared('key:1', fetcher)
      expect(result).toBeNull()
      expect(options.storeEntry).not.toHaveBeenCalled()
    })

    it('null fetch result stores empty with negative caching enabled', async () => {
      const { reader, options } = createReader()
      options.layers = [createMockLayer('L0')]
      options.negativeCaching = true
      options.storeEntry = vi.fn(async () => {})
      const fetcher = vi.fn(async () => null)

      const result = await reader.getPrepared('key:1', fetcher)
      expect(result).toBeNull()
      expect(options.storeEntry).toHaveBeenCalledWith('key:1', 'empty', null, undefined)
    })

    it('shouldCache returning false skips storage but returns value', async () => {
      const { reader, options } = createReader()
      options.layers = [createMockLayer('L0')]
      options.storeEntry = vi.fn(async () => {})
      const fetcher = vi.fn(async () => 'value')

      const result = await reader.getPrepared('key:1', fetcher, {
        shouldCache: () => false
      })
      expect(result).toBe('value')
      expect(options.storeEntry).not.toHaveBeenCalled()
    })

    it('shouldCache error logs warning but continues', async () => {
      const { reader, options } = createReader()
      options.layers = [createMockLayer('L0')]
      options.storeEntry = vi.fn(async () => {})
      const fetcher = vi.fn(async () => 'value')
      const shouldCacheError = new Error('predicate fail')

      const result = await reader.getPrepared('key:1', fetcher, {
        shouldCache: () => {
          throw shouldCacheError
        }
      })
      expect(result).toBe('value')
      expect(options.storeEntry).toHaveBeenCalledWith('key:1', 'value', 'value', expect.anything())
      expect(options.logger.warn).toHaveBeenCalledWith('shouldCache-error', expect.objectContaining({ key: 'key:1' }))
    })
  })

  // --- fetchWithGuards ---

  describe('fetchWithGuards', () => {
    it('rechecks layers for fresh value before fetching', async () => {
      const { reader, options } = createReader()
      const freshEnvelope = createStoredValueEnvelope({ kind: 'value', value: 'recheck-hit', freshTtlMs: 60 })
      const layer = createMockLayer('L0', {
        get: vi
          .fn(async () => null)
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce(freshEnvelope)
      })
      options.layers = [layer]
      const fetcher = vi.fn(async () => 'fresh-fetched')

      const result = await reader.getPrepared('key:1', fetcher)
      // The recheck found a fresh value, so the fetcher doesn't run
      expect(result).toBe('recheck-hit')
    })

    it('uses stampedeGuard for deduplication', async () => {
      const { reader, options } = createReader()
      options.layers = [createMockLayer('L0')]
      const spy = vi.spyOn(options.stampedeGuard, 'execute')
      options.storeEntry = vi.fn(async () => {})
      const fetcher = vi.fn(async () => 'data')

      await reader.getPrepared('key:1', fetcher)
      expect(spy).toHaveBeenCalledWith('key:1', expect.any(Function))
    })

    it('falls back to direct fetch when stampedePrevention is false', async () => {
      const { reader, options } = createReader()
      options.layers = [createMockLayer('L0')]
      options.stampedePrevention = false
      const spy = vi.spyOn(options.stampedeGuard, 'execute')
      options.storeEntry = vi.fn(async () => {})
      const fetcher = vi.fn(async () => 'direct')

      await reader.getPrepared('key:1', fetcher)
      expect(spy).not.toHaveBeenCalled()
    })

    it('graceful degradation on single-flight coordinator failure', async () => {
      const { reader, options } = createReader()
      options.layers = [createMockLayer('L0')]
      options.isGracefulDegradationEnabled.mockReturnValue(true)
      options.singleFlightCoordinator = {
        execute: vi.fn(async () => {
          throw new Error('coordinator fail')
        })
      }
      options.storeEntry = vi.fn(async () => {})
      const fetcher = vi.fn(async () => 'degraded-result')

      const result = await reader.getPrepared('key:1', fetcher)
      expect(result).toBe('degraded-result')
      expect(options.metricsCollector.snapshot.degradedOperations).toBe(1)
      expect(options.emitError).toHaveBeenCalledWith(
        'single-flight',
        expect.objectContaining({ key: 'key:1', degraded: true })
      )
    })
  })

  // --- waitForFreshValue ---

  describe('waitForFreshValue', () => {
    it('polls and returns when fresh value appears', async () => {
      const { reader, options } = createReader()
      const freshEnvelope = createStoredValueEnvelope({ kind: 'value', value: 'polled-fresh', freshTtlMs: 60 })
      const layer = createMockLayer('L0', {
        get: vi
          .fn()
          .mockResolvedValueOnce(null) // initial miss in getPrepared
          .mockResolvedValueOnce(null) // first readFromLayers (miss) in fetchWithGuards
          .mockResolvedValueOnce(null) // fresh-only recheck (miss)
          .mockResolvedValueOnce(null) // waitForFreshValue poll 1
          .mockResolvedValue(freshEnvelope) // waitForFreshValue poll 2
      })
      options.layers = [layer]
      options.singleFlightCoordinator = {
        execute: vi.fn(
          async (
            _key: string,
            _opts: unknown,
            worker: () => Promise<string | null>,
            waiter: () => Promise<string | null>
          ) => {
            return waiter()
          }
        )
      }
      options.singleFlightTimeoutMs = 5_000
      options.singleFlightPollMs = 10

      const fetcher = vi.fn(async () => 'fetched')
      const result = await reader.getPrepared('key:1', fetcher)
      expect(result).toBe('polled-fresh')
      expect(options.metricsCollector.snapshot.singleFlightWaits).toBeGreaterThanOrEqual(1)
    })

    it('falls back to fetchAndPopulate on timeout', async () => {
      vi.useFakeTimers()
      const { reader, options } = createReader()
      const layer = createMockLayer('L0', {
        get: vi.fn(async () => null)
      })
      options.layers = [layer]
      options.singleFlightCoordinator = {
        execute: vi.fn(
          async (
            _key: string,
            _opts: unknown,
            worker: () => Promise<string | null>,
            waiter: () => Promise<string | null>
          ) => {
            return waiter()
          }
        )
      }
      options.singleFlightTimeoutMs = 100
      options.singleFlightPollMs = 50
      options.sleep = vi.fn(async (ms: number) => {
        vi.advanceTimersByTime(ms)
      })
      options.storeEntry = vi.fn(async () => {})
      const fetcher = vi.fn(async () => 'timeout-fetch')

      const result = await reader.getPrepared('key:1', fetcher)
      expect(result).toBe('timeout-fetch')
    })
  })

  // --- Background refresh management ---

  describe('background refresh management', () => {
    it('activeRefreshCount tracks in-flight refreshes', () => {
      const { reader, options } = createReader()
      expect(reader.activeRefreshCount).toBe(0)

      const stale = createStoredValueEnvelope({
        kind: 'value',
        value: 'v',
        freshTtlMs: 1_000,
        staleWhileRevalidateMs: 60_000,
        now: Date.now() - 2_000
      })
      options.layers = [createMockLayer('L0', { get: vi.fn(async () => stale) })]
      const fetcher = vi.fn(async () => {
        // Keep the refresh in-flight long enough to observe
        await new Promise((r) => setTimeout(r, 100))
        return 'refreshed'
      })

      reader.runScheduleBackgroundRefresh('key:1', fetcher)
      expect(reader.activeRefreshCount).toBe(1)
    })

    it('abortAllRefreshes sets abort flags', async () => {
      const { reader, options } = createReader()
      const fetcher = vi.fn(async () => {
        await new Promise((r) => setTimeout(r, 200))
        return 'data'
      })

      reader.runScheduleBackgroundRefresh('key:1', fetcher)
      expect(reader.activeRefreshCount).toBe(1)

      reader.abortAllRefreshes()
      // Wait for refresh to complete after abort
      await Promise.all(reader.getAllRefreshPromises())
      expect(reader.activeRefreshCount).toBe(0)
    })

    it('getAllRefreshPromises returns all refresh promises', () => {
      const { reader, options } = createReader()
      const fetcher = vi.fn(async () => {
        await new Promise((r) => setTimeout(r, 100))
        return 'x'
      })

      reader.runScheduleBackgroundRefresh('key:a', fetcher)
      reader.runScheduleBackgroundRefresh('key:b', fetcher)

      const promises = reader.getAllRefreshPromises()
      expect(promises).toHaveLength(2)
    })

    it('does not schedule refresh when disconnecting', () => {
      const { reader, options } = createReader()
      options.isDisconnecting.mockReturnValue(true)
      const fetcher = vi.fn(async () => 'data')

      reader.runScheduleBackgroundRefresh('key:1', fetcher)
      expect(reader.activeRefreshCount).toBe(0)
    })

    it('returns from background refresh when abort flags are set before work starts', async () => {
      const { reader, options } = createReader()
      const fetcher = vi.fn(async () => 'data')
      const originalIncrement = options.metricsCollector.increment.bind(options.metricsCollector)
      vi.spyOn(options.metricsCollector, 'increment').mockImplementation((field, amount) => {
        originalIncrement(field, amount)
        if (field === 'refreshes') {
          ;(reader as unknown as { backgroundRefreshAbort: Map<string, boolean> }).backgroundRefreshAbort.set(
            'key:1',
            true
          )
        }
      })

      reader.runScheduleBackgroundRefresh('key:1', fetcher)
      await Promise.all(reader.getAllRefreshPromises())

      expect(fetcher).not.toHaveBeenCalled()
    })

    it('suppresses background refresh errors when abort flags are set during the refresh', async () => {
      const { reader, options } = createReader()
      options.layers = [createMockLayer('L0')]
      options.withTimeout = vi.fn(async () => {
        ;(reader as unknown as { backgroundRefreshAbort: Map<string, boolean> }).backgroundRefreshAbort.set(
          'key:1',
          true
        )
        throw new Error('aborted refresh')
      })
      const fetcher = vi.fn(async () => 'data')

      reader.runScheduleBackgroundRefresh('key:1', fetcher)
      await Promise.all(reader.getAllRefreshPromises())

      expect(options.metricsCollector.snapshot.refreshErrors).toBe(0)
    })
  })

  // --- resolveSingleFlightOptions ---

  describe('resolveSingleFlightOptions', () => {
    it('returns config values with defaults', async () => {
      const { reader, options } = createReader()
      options.layers = [createMockLayer('L0')]
      options.singleFlightLeaseMs = 50_000
      options.singleFlightTimeoutMs = 10_000
      options.singleFlightPollMs = 100
      options.singleFlightRenewIntervalMs = 5_000
      options.singleFlightCoordinator = {
        execute: vi.fn(async (_key: string, execOpts: unknown, worker: () => Promise<string | null>) => {
          // Capture the options passed to execute
          const opts = execOpts as Record<string, unknown>
          expect(opts.leaseMs).toBe(50_000)
          expect(opts.waitTimeoutMs).toBe(10_000)
          expect(opts.pollIntervalMs).toBe(100)
          expect(opts.renewIntervalMs).toBe(5_000)
          return worker()
        })
      }
      options.storeEntry = vi.fn(async () => {})
      const fetcher = vi.fn(async () => 'result')

      await reader.getPrepared('key:1', fetcher)
    })
  })

  // --- applyFreshReadPolicies ---

  describe('applyFreshReadPolicies', () => {
    it('writes refreshed envelope to layers on sliding TTL', async () => {
      const { reader, options } = createReader()
      const envelope = createStoredValueEnvelope({ kind: 'value', value: 'slide', freshTtlMs: 60 })
      const layer0 = createMockLayer('L0', { get: vi.fn(async () => envelope) })
      const layer1 = createMockLayer('L1')
      options.layers = [layer0, layer1]

      await reader.runApplyFreshReadPolicies(
        'key:1',
        {
          found: true,
          value: 'slide',
          stored: envelope,
          state: 'fresh',
          layerIndex: 1,
          layerName: 'L1'
        },
        { slidingTtl: true },
        undefined
      )

      // Both layers up to layerIndex=1 should get set called
      expect(layer0.set).toHaveBeenCalled()
      expect(layer1.set).toHaveBeenCalled()
    })

    it('schedules background refresh when refresh-ahead threshold is met', async () => {
      const { reader, options } = createReader()
      const envelope = createStoredValueEnvelope({ kind: 'value', value: 'ahead', freshTtlMs: 10 })
      const layer = createMockLayer('L0', { get: vi.fn(async () => envelope) })
      options.layers = [layer]
      options.refreshAhead = 600_000
      options.resolveLayerMs.mockReturnValue(600_000)
      const fetcher = vi.fn(async () => 'refreshed')

      await reader.runApplyFreshReadPolicies(
        'key:1',
        {
          found: true,
          value: 'ahead',
          stored: envelope,
          state: 'fresh',
          layerIndex: 0,
          layerName: 'L0'
        },
        undefined,
        fetcher
      )

      expect(options.scheduleBackgroundRefreshDispatch).toHaveBeenCalledWith('key:1', fetcher, undefined, {
        key: 'key:1',
        currentValue: 'ahead',
        state: 'fresh',
        layer: 'L0'
      } satisfies CacheFetcherContext<string>)
    })

    it('uses undefined currentValue when a null cache value schedules refresh ahead', async () => {
      const { reader, options } = createReader()
      const envelope = createStoredValueEnvelope({ kind: 'empty', freshTtlMs: 10 })
      options.refreshAhead = 600_000
      options.resolveLayerMs.mockReturnValue(600_000)
      const fetcher = vi.fn(async () => 'refreshed')

      await reader.runApplyFreshReadPolicies(
        'key:empty',
        {
          found: true,
          value: null,
          stored: envelope,
          state: 'fresh',
          layerIndex: 0,
          layerName: 'L0'
        },
        undefined,
        fetcher
      )

      expect(options.scheduleBackgroundRefreshDispatch).toHaveBeenCalledWith('key:empty', fetcher, undefined, {
        key: 'key:empty',
        currentValue: undefined,
        state: 'fresh',
        layer: 'L0'
      } satisfies CacheFetcherContext<string>)
    })
  })

  // --- negative cache hits ---

  describe('negative cache hit detection', () => {
    it('increments negativeCacheHits when serving a negative-cache entry', async () => {
      const { reader, options } = createReader()
      const negative = createStoredValueEnvelope({
        kind: 'empty',
        freshTtlMs: 60_000
      })
      options.layers = [createMockLayer('L0', { get: vi.fn(async () => negative) })]

      const result = await reader.getPrepared('key:1')
      expect(result).toBeNull()
      expect(options.metricsCollector.snapshot.negativeCacheHits).toBe(1)
    })
  })
})
