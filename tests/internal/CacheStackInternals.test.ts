import { describe, expect, it, vi } from 'vitest'
import { CacheStack } from '../../src/CacheStack'
import { generationPrefix, stripGenerationPrefix } from '../../src/internal/CacheStackGeneration'
import { createStoredValueEnvelope } from '../../src/internal/StoredValue'
import { MemoryLayer } from '../../src/layers/MemoryLayer'
import type { CacheLayer } from '../../src/types'
import type { CacheFetcher, CacheFetcherContext } from '../../src/types'

function makeLayer(name: string, overrides: Partial<CacheLayer> = {}): CacheLayer {
  return {
    name,
    get: async () => null,
    set: async () => undefined,
    delete: async () => undefined,
    clear: async () => undefined,
    ...overrides
  }
}

describe('CacheStack internals', () => {
  it('uses the internal debug logger with and without context and respects disabled logging', () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined)

    try {
      const enabled = new CacheStack([new MemoryLayer({ ttl: 60_000 })], { logger: true })
      ;(enabled as { logger: { info: (message: string, context?: Record<string, unknown>) => void } }).logger.info(
        'hello',
        { ok: true }
      )
      ;(enabled as { logger: { info: (message: string, context?: Record<string, unknown>) => void } }).logger.info(
        'plain'
      )

      const disabled = new CacheStack([new MemoryLayer({ ttl: 60_000 })], { logger: false })
      ;(disabled as { logger: { info: (message: string, context?: Record<string, unknown>) => void } }).logger.info(
        'quiet',
        { ignored: true }
      )

      expect(infoSpy).toHaveBeenNthCalledWith(1, '[layercache] hello {"ok":true}')
      expect(infoSpy).toHaveBeenNthCalledWith(2, '[layercache] plain')
      expect(infoSpy).toHaveBeenCalledTimes(2)
    } finally {
      infoSpy.mockRestore()
    }
  })

  it('falls back to layer.get in has() and tolerates recoverable failures', async () => {
    const errorListener = vi.fn()
    const nullLayer = makeLayer('null-layer', { get: vi.fn(async () => null) })
    const valueLayer = makeLayer('value-layer', { get: vi.fn(async () => 'hit') })
    const throwingLayer = makeLayer('throwing-layer', {
      get: vi.fn(async () => {
        throw new Error('boom')
      })
    })

    const missCache = new CacheStack([nullLayer])
    await expect(missCache.has('user:1')).resolves.toBe(false)

    const hitCache = new CacheStack([nullLayer, valueLayer])
    await expect(hitCache.has('user:1')).resolves.toBe(true)

    const degradedCache = new CacheStack([throwingLayer, valueLayer], { gracefulDegradation: true })
    degradedCache.on('error', errorListener)
    await expect(degradedCache.has('user:1')).resolves.toBe(true)
    expect(errorListener).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'has', degraded: true, layer: 'throwing-layer' })
    )
  })

  it('sorts warm entries by priority and can either continue or stop on error', async () => {
    const cache = new CacheStack([new MemoryLayer({ ttl: 60_000 })])
    const order: string[] = []
    const progress: Array<{ key: string; success: boolean }> = []

    await cache.warm(
      [
        {
          key: 'low',
          priority: 1,
          fetcher: async () => {
            order.push('low')
            return 'low'
          }
        },
        {
          key: 'high',
          priority: 10,
          fetcher: async () => {
            order.push('high')
            throw new Error('nope')
          }
        },
        {
          key: 'mid',
          priority: 5,
          fetcher: async () => {
            order.push('mid')
            return 'mid'
          }
        }
      ],
      {
        concurrency: 1,
        continueOnError: true,
        onProgress: (entry) => progress.push({ key: entry.key, success: entry.success })
      }
    )

    expect(order).toEqual(['high', 'mid', 'low'])
    expect(progress).toEqual([
      { key: 'high', success: false },
      { key: 'mid', success: true },
      { key: 'low', success: true }
    ])

    await expect(
      cache.warm(
        [
          {
            key: 'boom',
            fetcher: async () => {
              throw new Error('stop')
            }
          }
        ],
        { concurrency: 0 }
      )
    ).rejects.toThrow('stop')
  })

  it('handles generation prefixes and invalidation key limits through internal helpers', async () => {
    const cache = new CacheStack([new MemoryLayer({ ttl: 60_000 })], { generation: 2, invalidationMaxKeys: false })

    expect(generationPrefix(2)).toBe('v2:')
    expect(stripGenerationPrefix('v2:user:1', 2)).toBe('user:1')
    expect(stripGenerationPrefix('user:1', 2)).toBe('user:1')
    expect((cache as { invalidationMaxKeys: () => number | false }).invalidationMaxKeys()).toBe(false)

    const limited = new CacheStack([new MemoryLayer({ ttl: 60_000 })], { invalidationMaxKeys: 1 })
    expect(() =>
      (
        limited as {
          invalidation: { assertWithinInvalidationKeyLimit: (size: number, maxKeys: number | false) => void }
        }
      ).invalidation.assertWithinInvalidationKeyLimit(2, 1)
    ).toThrow(/too many keys/i)
  })

  it('routes recoverable failures through degraded and non-degraded paths', async () => {
    const degradedErrors: unknown[] = []
    const degraded = new CacheStack([new MemoryLayer({ ttl: 60_000 })], {
      gracefulDegradation: { retryAfterMs: 50 }
    })
    degraded.on('error', (event) => degradedErrors.push(event))

    await expect(
      (
        degraded as {
          reportRecoverableLayerFailure: (layer: CacheLayer, operation: string, error: unknown) => Promise<void>
        }
      ).reportRecoverableLayerFailure(makeLayer('memory'), 'read', new Error('fail'))
    ).resolves.toBeUndefined()
    expect(degradedErrors).toEqual([expect.objectContaining({ operation: 'read', degraded: true })])

    const plainWarnings: unknown[] = []
    const plain = new CacheStack([new MemoryLayer({ ttl: 60_000 })], {
      logger: { warn: (...args: unknown[]) => plainWarnings.push(args) }
    })
    plain.on('error', (event) => degradedErrors.push(event))

    await expect(
      (
        plain as {
          reportRecoverableLayerFailure: (layer: CacheLayer, operation: string, error: unknown) => Promise<void>
        }
      ).reportRecoverableLayerFailure(makeLayer('memory'), 'read', new Error('fail'))
    ).resolves.toBeUndefined()
    expect(plainWarnings).toHaveLength(1)
    expect(degradedErrors).toContainEqual(expect.objectContaining({ operation: 'read', degraded: false }))
  })

  it('reads layer entries through getEntry/get and exports only distinct non-null entries', async () => {
    const layerWithEntry = makeLayer('entry-layer', {
      forEachKey: async (visitor) => {
        await visitor('v3:user:1')
        await visitor('v3:user:1')
        await visitor('v3:missing')
      }
    })
    const layerWithKeys = makeLayer('keys-layer', {
      keys: async () => ['v3:user:2']
    })
    const cache = new CacheStack([layerWithEntry, layerWithKeys], { generation: 3 })
    const readLayerEntry = vi.fn(async (_layer: CacheLayer, key: string) => {
      if (key.endsWith('missing')) {
        return null
      }
      return { kind: 'value', value: key }
    })
    ;(
      cache as {
        snapshots: {
          options: { readLayerEntry: (layer: CacheLayer, key: string) => Promise<unknown | null> }
        }
      }
    ).snapshots.options.readLayerEntry = readLayerEntry

    const exported: Array<{ key: string; value: unknown }> = []
    await (
      cache as {
        snapshots: {
          visitExportEntries: (
            maxEntries: number | false,
            visitor: (entry: { key: string; value: unknown; ttl?: number }) => Promise<void> | void
          ) => Promise<void>
        }
      }
    ).snapshots.visitExportEntries(false, (entry) => {
      exported.push({ key: entry.key, value: entry.value })
    })

    expect(exported).toEqual([
      { key: 'user:1', value: { kind: 'value', value: 'v3:user:1' } },
      { key: 'user:2', value: { kind: 'value', value: 'v3:user:2' } }
    ])
    expect(readLayerEntry).toHaveBeenCalled()
  })

  it('uses snapshot and invalidation defaults unless explicitly disabled', () => {
    const defaults = new CacheStack([new MemoryLayer({ ttl: 60_000 })])
    expect((defaults as { snapshotMaxBytes: () => number | false }).snapshotMaxBytes()).toBe(16 * 1_024 * 1_024)
    expect((defaults as { snapshotMaxEntries: () => number | false }).snapshotMaxEntries()).toBe(10_000)
    expect((defaults as { invalidationMaxKeys: () => number | false }).invalidationMaxKeys()).toBe(10_000)

    const disabled = new CacheStack([new MemoryLayer({ ttl: 60_000 })], {
      snapshotMaxBytes: false,
      snapshotMaxEntries: false,
      invalidationMaxKeys: false
    })
    expect((disabled as { snapshotMaxBytes: () => number | false }).snapshotMaxBytes()).toBe(false)
    expect((disabled as { snapshotMaxEntries: () => number | false }).snapshotMaxEntries()).toBe(false)
    expect((disabled as { invalidationMaxKeys: () => number | false }).invalidationMaxKeys()).toBe(false)
  })

  it('validates constructor configuration and emits warning branches for risky setups', async () => {
    expect(() => new CacheStack([])).toThrow(/at least one cache layer/i)

    expect(
      () =>
        new CacheStack([new MemoryLayer({ ttl: 60_000 })], {
          broadcastL1Invalidation: true,
          publishSetInvalidation: false
        })
    ).toThrow(/cannot conflict/i)

    expect(
      () =>
        new CacheStack([new MemoryLayer({ ttl: 60_000 })], {
          stampedePrevention: false,
          singleFlightCoordinator: { execute: vi.fn() } as never
        })
    ).toThrow(/stampedePrevention/i)

    expect(
      () =>
        new CacheStack([new MemoryLayer({ ttl: 60_000 })], {
          generationCleanup: { maxMatches: 0 }
        })
    ).toThrow(/generationCleanup\.maxMatches/i)

    for (const [option, value] of [
      ['maxPendingWrites', 0],
      ['maxActiveKeys', -1],
      ['maxPendingWritesPerKey', Number.NaN]
    ] as const) {
      expect(
        () =>
          new CacheStack([new MemoryLayer({ ttl: 60_000 })], {
            writeCoordination: { [option]: value }
          })
      ).toThrow(new RegExp(`writeCoordination\\.${option}`, 'i'))
    }

    const warn = vi.fn()
    const bus = {
      subscribe: vi.fn(async () => () => undefined),
      publish: vi.fn(async () => undefined)
    }
    const cache = new CacheStack(
      [
        makeLayer('remote-layer', {
          isLocal: false
        })
      ],
      {
        logger: { warn },
        invalidationBus: bus
      }
    )

    await cache.disconnect()

    const messages = warn.mock.calls.map(([message]) => String(message))
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          'default in-memory TagIndex with a shared cache layer only tracks keys seen by this process'
        ),
        expect.stringContaining(
          'does not implement keys() can leave invalidateByPattern() and invalidateByPrefix() incomplete'
        ),
        expect.stringContaining('broadcastL1Invalidation defaults to false')
      ])
    )
  })

  it('covers ttl, healthCheck, and inspect branches across skipped, failing, and ttl-less layers', async () => {
    const skippedLayer = makeLayer('skipped', {
      get: vi.fn(async () => {
        throw new Error('skip me')
      }),
      ttl: vi.fn(async () => 99)
    })
    const throwingLayer = makeLayer('throwing', {
      ttl: vi.fn(async () => {
        throw new Error('ttl failed')
      }),
      ping: vi.fn(async () => {
        throw new Error('down')
      })
    })
    const valueLayer = makeLayer('value', {
      ttl: vi.fn(async () => 12)
    })
    const cache = new CacheStack([skippedLayer, throwingLayer, valueLayer], {
      gracefulDegradation: true
    })

    await expect(cache.has('prime:skip')).resolves.toBe(false)

    await expect(cache.ttl('user:1')).resolves.toBe(12)

    const health = await cache.healthCheck()
    expect(health).toEqual([
      expect.objectContaining({ layer: 'skipped', healthy: true }),
      expect.objectContaining({ layer: 'throwing', healthy: false, error: 'down' }),
      expect.objectContaining({ layer: 'value', healthy: true })
    ])

    const staleEnvelope = createStoredValueEnvelope({
      kind: 'value',
      value: { id: 1 },
      freshTtlMs: 1_000,
      staleWhileRevalidateMs: 10_000,
      staleIfErrorMs: 15_000,
      now: Date.now() - 2_000
    })
    const inspectCache = new CacheStack([makeLayer('inspect-layer')])
    const readLayerEntry = vi
      .spyOn(
        inspectCache as unknown as {
          readLayerEntry: (layer: CacheLayer, key: string) => Promise<unknown | null>
        },
        'readLayerEntry'
      )
      .mockResolvedValueOnce(staleEnvelope)
      .mockResolvedValueOnce(staleEnvelope)

    await expect(inspectCache.inspect('user:1')).resolves.toEqual(
      expect.objectContaining({
        key: 'user:1',
        foundInLayers: ['inspect-layer'],
        isStale: true,
        tags: []
      })
    )

    readLayerEntry.mockRestore()
  })

  it('covers empty deletes, mget edge cases, and read-layer fallbacks', async () => {
    const deleteSpy = vi.fn(async () => undefined)
    const getManyLayer = makeLayer('bulk', {
      getMany: vi.fn(async () => [
        createStoredValueEnvelope({
          kind: 'value',
          value: 'expired',
          freshTtlMs: 1_000,
          now: Date.now() - 5_000
        }),
        null
      ]),
      delete: deleteSpy
    })
    const cache = new CacheStack([getManyLayer])

    await expect(cache.mdelete([])).resolves.toBeUndefined()
    await expect(cache.mget([])).resolves.toEqual([])
    await expect(cache.mget([{ key: 'a' }, { key: 'b' }])).resolves.toEqual([undefined, undefined])
    expect(deleteSpy).toHaveBeenCalledWith('a')

    await expect(
      cache.mget([
        { key: 'same', fetch: async () => 'a' },
        { key: 'same', fetch: async () => 'b' }
      ])
    ).rejects.toThrow(/conflicting entries/i)

    const entryLayer = makeLayer('entry', {
      getEntry: vi.fn(async () => {
        throw new Error('entry-failed')
      })
    })
    const plainLayer = makeLayer('plain', {
      get: vi.fn(async () => {
        throw new Error('plain-failed')
      })
    })
    const degraded = new CacheStack([entryLayer, plainLayer], { gracefulDegradation: true })

    await expect(
      (degraded as { readLayerEntry: (layer: CacheLayer, key: string) => Promise<unknown | null> }).readLayerEntry(
        entryLayer,
        'user:1'
      )
    ).resolves.toBeNull()
    await expect(
      (degraded as { readLayerEntry: (layer: CacheLayer, key: string) => Promise<unknown | null> }).readLayerEntry(
        plainLayer,
        'user:2'
      )
    ).resolves.toBeNull()
  })

  it('expires layer entries through invalidation support edge cases', async () => {
    const skippedGetEntry = vi.fn(async () => createStoredValueEnvelope({ kind: 'value', value: 'skip' }))
    const skippedSet = vi.fn(async () => undefined)
    const skippedLayer = makeLayer('skipped-expire', {
      get: vi.fn(async () => {
        throw new Error('degrade first')
      }),
      getEntry: skippedGetEntry,
      set: skippedSet
    })
    const set = vi.fn(async () => undefined)
    const layer = makeLayer('expire-layer', {
      get: vi.fn(async (key: string) => (key === 'plain' ? 'plain-value' : null)),
      getEntry: vi.fn(async (key: string) => {
        if (key === 'missing') {
          return null
        }
        if (key === 'plain') {
          return 'plain-value'
        }
        if (key === 'boom') {
          throw new Error('expire failed')
        }
        return createStoredValueEnvelope({
          kind: 'value',
          value: { id: 1 },
          freshTtlMs: 60_000,
          staleWhileRevalidateMs: 30_000
        })
      }),
      set
    })
    const cache = new CacheStack([skippedLayer, layer], { gracefulDegradation: true })
    const failures: unknown[] = []
    cache.on('error', (event) => failures.push(event))

    await expect(cache.has('prime:skip')).resolves.toBe(false)

    await expect(
      (
        cache as {
          invalidation: {
            expireKeysInLayers: (layers: CacheLayer[], keys: string[]) => Promise<Set<string>>
          }
        }
      ).invalidation.expireKeysInLayers([skippedLayer, layer], ['missing', 'plain', 'fresh', 'boom'])
    ).resolves.toEqual(new Set(['plain', 'fresh']))

    expect(skippedGetEntry).not.toHaveBeenCalled()
    expect(skippedSet).not.toHaveBeenCalled()
    expect(set).toHaveBeenCalledTimes(1)
    expect(set).toHaveBeenCalledWith(
      'fresh',
      expect.objectContaining({
        __layercache: 1,
        freshTtlMs: 60_000,
        staleWhileRevalidateMs: 30_000
      }),
      expect.any(Number)
    )
    expect(failures).toContainEqual(expect.objectContaining({ layer: 'expire-layer', operation: 'expire' }))

    await expect(
      (
        cache as {
          expireKeysInLayers: (keys: string[], layers: CacheLayer[]) => Promise<Set<string>>
        }
      ).expireKeysInLayers([], [layer])
    ).resolves.toEqual(new Set())
  })

  it('reports invalidation delete failures and get-fallback expire misses', async () => {
    const deleteManyLayer = makeLayer('delete-many-fails', {
      deleteMany: vi.fn(async () => {
        throw new Error('bulk delete failed')
      })
    })
    const deleteLayer = makeLayer('delete-fails', {
      delete: vi.fn(async () => {
        throw new Error('delete failed')
      })
    })
    const getFallbackLayer = makeLayer('get-fallback-miss', {
      get: vi.fn(async () => null)
    })
    const cache = new CacheStack([deleteManyLayer, deleteLayer, getFallbackLayer], { gracefulDegradation: true })
    const failures: unknown[] = []
    cache.on('error', (event) => failures.push(event))

    await (
      cache as {
        invalidation: {
          deleteKeysFromLayers: (layers: CacheLayer[], keys: string[]) => Promise<void>
          expireKeysInLayers: (layers: CacheLayer[], keys: string[]) => Promise<Set<string>>
        }
      }
    ).invalidation.deleteKeysFromLayers([deleteManyLayer, deleteLayer], ['user:1'])

    await expect(
      (
        cache as {
          invalidation: {
            expireKeysInLayers: (layers: CacheLayer[], keys: string[]) => Promise<Set<string>>
          }
        }
      ).invalidation.expireKeysInLayers([getFallbackLayer], ['missing'])
    ).resolves.toEqual(new Set())

    expect(failures).toContainEqual(expect.objectContaining({ layer: 'delete-many-fails', operation: 'delete' }))
    expect(failures).toContainEqual(expect.objectContaining({ layer: 'delete-fails', operation: 'delete' }))
  })

  it('covers background refresh, invalidation-message, write-behind, and timeout branches', async () => {
    const cache = new CacheStack([new MemoryLayer({ ttl: 60_000 })], {
      writeStrategy: 'write-behind',
      writeBehind: { batchSize: 2, maxQueueSize: 3 }
    })

    await expect(
      (
        cache as { withTimeout: <T>(promise: Promise<T>, timeoutMs: number, onTimeout: () => Error) => Promise<T> }
      ).withTimeout(Promise.resolve('ok'), 0, () => new Error('timeout'))
    ).resolves.toBe('ok')
    await expect(
      (
        cache as { withTimeout: <T>(promise: Promise<T>, timeoutMs: number, onTimeout: () => Error) => Promise<T> }
      ).withTimeout(Promise.reject(new Error('boom')), 50, () => new Error('timeout'))
    ).rejects.toThrow('boom')

    const tagIndex = {
      clear: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
      touch: vi.fn(async () => undefined),
      matchPattern: vi.fn(async () => []),
      keysForTag: vi.fn(async () => []),
      track: vi.fn(async () => undefined)
    }
    const localLayer = makeLayer('local', { isLocal: true })
    const remoteAware = new CacheStack([localLayer], { tagIndex: tagIndex as never })

    await (
      remoteAware as {
        handleInvalidationMessage: (message: {
          scope: 'clear' | 'key' | 'keys'
          sourceId: string
          operation?: 'write' | 'clear' | 'delete' | 'invalidate'
          keys?: string[]
        }) => Promise<void>
      }
    ).handleInvalidationMessage({
      scope: 'key',
      keys: ['user:1'],
      sourceId: 'remote',
      operation: 'write'
    })
    expect(tagIndex.remove).not.toHaveBeenCalled()

    await (
      remoteAware as {
        handleInvalidationMessage: (message: {
          scope: 'clear' | 'key' | 'keys'
          sourceId: string
          operation?: 'write' | 'clear' | 'delete' | 'invalidate'
          keys?: string[]
        }) => Promise<void>
      }
    ).handleInvalidationMessage({
      scope: 'clear',
      sourceId: 'remote',
      operation: 'clear'
    })
    expect(tagIndex.clear).toHaveBeenCalled()

    await (
      remoteAware as {
        handleInvalidationMessage: (message: {
          scope: 'clear' | 'key' | 'keys'
          sourceId: string
          operation?: 'write' | 'clear' | 'delete' | 'invalidate'
          keys?: string[]
        }) => Promise<void>
      }
    ).handleInvalidationMessage({
      scope: 'keys',
      keys: ['user:1'],
      sourceId: (remoteAware as { instanceId: string }).instanceId,
      operation: 'invalidate'
    })
    expect(tagIndex.remove).toHaveBeenCalledTimes(0)

    const writeBehind = new CacheStack([new MemoryLayer({ ttl: 60_000 })], {
      writeStrategy: 'write-behind',
      writeBehind: { batchSize: 2, maxQueueSize: 3 },
      logger: true
    })
    const executed: string[] = []
    await (writeBehind as { enqueueWriteBehind: (operation: () => Promise<void>) => Promise<void> }).enqueueWriteBehind(
      async () => {
        executed.push('first')
      }
    )
    await (writeBehind as { enqueueWriteBehind: (operation: () => Promise<void>) => Promise<void> }).enqueueWriteBehind(
      async () => {
        executed.push('second')
      }
    )
    expect(executed).toEqual(['first', 'second'])

    const failingWriteBehind = new CacheStack([new MemoryLayer({ ttl: 60_000 })], {
      writeStrategy: 'write-behind',
      writeBehind: { batchSize: 1 }
    })
    const errorListener = vi.fn()
    failingWriteBehind.on('error', errorListener)
    await (
      failingWriteBehind as { enqueueWriteBehind: (operation: () => Promise<void>) => Promise<void> }
    ).enqueueWriteBehind(async () => {
      throw new Error('flush-failed')
    })
    expect(errorListener).toHaveBeenCalledWith(expect.objectContaining({ operation: 'write-behind', failed: 1 }))
  })

  it('covers generation cleanup, key intersection, layer deletion, and fresh-read policy branches', async () => {
    const cache = new CacheStack([new MemoryLayer({ ttl: 60_000 })], {
      generation: 1,
      generationCleanup: { batchSize: 2 }
    })

    await expect(
      (cache as { cleanupGeneration: (generation: number) => Promise<void> }).cleanupGeneration(1)
    ).resolves.toBeUndefined()

    expect(
      (cache as { invalidation: { intersectKeys: (groups: string[][]) => string[] } }).invalidation.intersectKeys([])
    ).toEqual([])
    expect(
      (cache as { invalidation: { intersectKeys: (groups: string[][]) => string[] } }).invalidation.intersectKeys([
        ['a', 'b', 'b'],
        ['b', 'c'],
        ['b']
      ])
    ).toEqual(['b'])

    const policyCache = new CacheStack([makeLayer('policy', { set: vi.fn(async () => undefined) })])
    const scheduleSpy = vi
      .spyOn(
        policyCache as object as {
          scheduleBackgroundRefresh: (
            key: string,
            fetcher: CacheFetcher<string>,
            options?: unknown,
            fetcherContext?: CacheFetcherContext<string>
          ) => void
        },
        'scheduleBackgroundRefresh'
      )
      .mockImplementation(() => undefined)
    await (
      policyCache as {
        applyFreshReadPolicies: (
          key: string,
          hit: {
            found: true
            value: string
            stored: unknown
            state: 'fresh'
            layerIndex: number
            layerName: string
          },
          options: { refreshAhead?: number; slidingTtl?: boolean },
          fetcher?: CacheFetcher<string>
        ) => Promise<void>
      }
    ).applyFreshReadPolicies(
      'user:1',
      {
        found: true,
        value: 'value',
        stored: createStoredValueEnvelope({
          kind: 'value',
          value: 'value',
          freshTtlMs: 60_000
        }),
        state: 'fresh',
        layerIndex: 0,
        layerName: 'policy'
      },
      { refreshAhead: 120_000, slidingTtl: true },
      async () => 'fresh'
    )
    expect(scheduleSpy).toHaveBeenCalled()
    scheduleSpy.mockRestore()
  })

  it('streams generation cleanup in batches without materializing all old-generation keys first', async () => {
    const cache = new CacheStack([new MemoryLayer({ ttl: 60_000 })], {
      generationCleanup: { batchSize: 2 }
    })
    const keyDiscovery = (
      cache as unknown as {
        keyDiscovery: {
          collectKeysWithPrefix: (...args: unknown[]) => Promise<string[]>
          forEachKeyWithPrefix: (prefix: string, visitor: (key: string) => Promise<void>) => Promise<void>
        }
      }
    ).keyDiscovery
    const collectSpy = vi.spyOn(keyDiscovery, 'collectKeysWithPrefix')
    const forEachSpy = vi.spyOn(keyDiscovery, 'forEachKeyWithPrefix').mockImplementation(async (_prefix, visitor) => {
      await visitor('v1:a')
      await visitor('v1:b')
      await visitor('v1:c')
    })
    const deleteKeysSpy = vi.spyOn(cache as unknown as { deleteKeys: (keys: string[]) => Promise<void> }, 'deleteKeys')

    await (cache as { cleanupGeneration: (generation: number) => Promise<void> }).cleanupGeneration(1)

    expect(collectSpy).not.toHaveBeenCalled()
    expect(forEachSpy).toHaveBeenCalledWith('v1:', expect.any(Function), 10_000)
    expect(deleteKeysSpy.mock.calls.map(([keys]) => keys)).toEqual([['v1:a', 'v1:b'], ['v1:c']])
  })

  it('covers tag fallback and sliding-ttl failure handling branches', async () => {
    const fallbackTagCache = new CacheStack([makeLayer('layer')], {
      tagIndex: {
        keysForTag: vi.fn(async () => []),
        matchPattern: vi.fn(async () => []),
        track: vi.fn(async () => undefined),
        touch: vi.fn(async () => undefined),
        remove: vi.fn(async () => undefined),
        clear: vi.fn(async () => undefined)
      } as never
    })

    await expect(
      (fallbackTagCache as unknown as { getTagsForKey: (key: string) => Promise<string[]> }).getTagsForKey('user:1')
    ).resolves.toEqual([])

    const failingSet = vi.fn(async () => {
      throw new Error('set failed')
    })
    const cache = new CacheStack([makeLayer('layer', { set: failingSet })])
    const handleLayerFailure = vi
      .spyOn(
        cache as unknown as {
          handleLayerFailure: (layer: CacheLayer, operation: string, error: unknown) => Promise<void>
        },
        'handleLayerFailure'
      )
      .mockResolvedValue(undefined)

    await (
      cache as unknown as {
        applyFreshReadPolicies: (
          key: string,
          hit: {
            found: true
            value: string
            stored: unknown
            state: 'fresh'
            layerIndex: number
            layerName: string
          },
          options: { refreshAhead?: number; slidingTtl?: boolean },
          fetcher?: CacheFetcher<string>
        ) => Promise<void>
      }
    ).applyFreshReadPolicies(
      'user:1',
      {
        found: true,
        value: 'value',
        stored: createStoredValueEnvelope({
          kind: 'value',
          value: 'value',
          freshTtlMs: 30_000
        }),
        state: 'fresh',
        layerIndex: 0,
        layerName: 'layer'
      },
      { slidingTtl: true }
    )

    expect(failingSet).toHaveBeenCalled()
    expect(handleLayerFailure).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'layer' }),
      'sliding-ttl',
      expect.any(Error)
    )
    handleLayerFailure.mockRestore()
  })

  it('covers circuit recording, error emission, snapshot validation, tag fallback, and export-key branches', async () => {
    const cache = new CacheStack([new MemoryLayer({ ttl: 60_000 })], {
      circuitBreaker: { failureThreshold: 1, cooldownMs: 50 }
    })
    ;(
      cache as {
        recordCircuitFailure: (
          key: string,
          breakerKey: string,
          options: { failureThreshold: number; cooldownMs: number } | undefined,
          error: unknown
        ) => void
      }
    ).recordCircuitFailure('user:1', 'user:1', undefined, new Error('ignored'))
    expect(cache.getMetrics().circuitBreakerTrips).toBe(0)
    ;(
      cache as {
        recordCircuitFailure: (
          key: string,
          breakerKey: string,
          options: { failureThreshold: number; cooldownMs: number } | undefined,
          error: unknown
        ) => void
      }
    ).recordCircuitFailure('user:1', 'user:1', { failureThreshold: 1, cooldownMs: 50 }, new Error('boom'))
    expect(cache.getMetrics().circuitBreakerTrips).toBe(1)

    const emitted: unknown[] = []
    cache.on('error', (event) => emitted.push(event))
    ;(cache as { emitError: (operation: string, context: Record<string, unknown>) => void }).emitError('custom', {
      reason: 'test'
    })
    expect(emitted).toEqual([expect.objectContaining({ operation: 'custom', reason: 'test' })])

    expect(
      (
        cache as { snapshots: { isCacheSnapshotEntries: (value: unknown) => boolean } }
      ).snapshots.isCacheSnapshotEntries([{ key: 'ok', ttl: 1, value: { id: 1 } }])
    ).toBe(true)
    expect(
      (
        cache as { snapshots: { isCacheSnapshotEntries: (value: unknown) => boolean } }
      ).snapshots.isCacheSnapshotEntries([{ key: 'bad', ttl: -1 }])
    ).toBe(false)
    expect(
      (
        cache as { snapshots: { isCacheSnapshotEntries: (value: unknown) => boolean } }
      ).snapshots.isCacheSnapshotEntries([null])
    ).toBe(false)

    const tagIndex = {
      keysForTag: vi.fn(async () => ['user:1']),
      matchPattern: vi.fn(async () => []),
      track: vi.fn(async () => undefined),
      touch: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
      clear: vi.fn(async () => undefined),
      tagsForKey: vi.fn(async () => ['team:a'])
    }
    const tagCache = new CacheStack([makeLayer('layer')], { tagIndex: tagIndex as never })
    await expect(
      (
        tagCache as { invalidation: { collectKeysForTag: (tag: string, maxKeys: number | false) => Promise<string[]> } }
      ).invalidation.collectKeysForTag('team:a', false)
    ).resolves.toEqual(['user:1'])
    await expect(
      (tagCache as { getTagsForKey: (key: string) => Promise<string[]> }).getTagsForKey('user:1')
    ).resolves.toEqual(['team:a'])

    const exportCache = new CacheStack([
      makeLayer('skip-layer'),
      makeLayer('keys-layer', {
        keys: vi.fn(async () => ['user:1'])
      })
    ])
    const readSpy = vi.fn(async () => ({ ok: true }))
    ;(
      exportCache as {
        snapshots: {
          options: { readLayerEntry: (layer: CacheLayer, key: string) => Promise<unknown | null> }
        }
      }
    ).snapshots.options.readLayerEntry = readSpy

    const entries: string[] = []
    await (
      exportCache as {
        snapshots: {
          visitExportEntries: (
            maxEntries: number | false,
            visitor: (entry: { key: string; value: unknown }) => Promise<void> | void
          ) => Promise<void>
        }
      }
    ).snapshots.visitExportEntries(false, (entry) => {
      entries.push(entry.key)
    })
    expect(entries).toEqual(['user:1'])
  })

  it('covers setMany fallback to individual set calls and best-effort write policy', async () => {
    const entries: Array<{ key: string; value: unknown; ttl?: number }> = []
    const layerWithoutSetMany = makeLayer('no-setmany', {
      set: vi.fn(async (key, value, ttl) => {
        entries.push({ key, value, ttl })
      })
    })

    const strictCache = new CacheStack([layerWithoutSetMany], { writePolicy: 'strict' })
    await strictCache.mset([
      { key: 'a', value: 1 },
      { key: 'b', value: 2 }
    ])
    expect(entries).toHaveLength(2)
    expect(entries[0]).toMatchObject({ key: 'a', value: expect.any(Object) })
    expect(entries[1]).toMatchObject({ key: 'b', value: expect.any(Object) })
    // ttl can be a number or undefined
    expect(entries[0].ttl === undefined || typeof entries[0].ttl === 'number').toBe(true)

    const errorLayer = makeLayer('error-layer', {
      set: vi.fn(async () => {
        throw new Error('write failed')
      })
    })
    const bestEffortCache = new CacheStack([errorLayer], {
      writePolicy: 'best-effort'
    })

    // When ALL layers fail in best-effort mode, it still throws AggregateError
    await expect(
      bestEffortCache.mset([
        { key: 'x', value: 1 },
        { key: 'y', value: 2 }
      ])
    ).rejects.toThrow(AggregateError)
    // Verify write failures were counted in metrics
    expect(bestEffortCache.getMetrics().writeFailures).toBeGreaterThan(0)

    const workingLayer = makeLayer('working', {
      set: vi.fn(async () => undefined)
    })
    const mixedCache = new CacheStack([errorLayer, workingLayer], {
      writePolicy: 'best-effort'
    })
    // When at least one layer succeeds, best-effort mode should not throw
    await expect(mixedCache.mset([{ key: 'mixed', value: 1 }])).resolves.toBeUndefined()
  })

  it('cleans up expired degradation entries from layerDegradedUntil', async () => {
    const layer = makeLayer('cleanup-layer')
    const cache = new CacheStack([layer], {
      gracefulDegradation: { retryAfterMs: 1 }
    })
    const map = (cache as { layerDegradedUntil: Map<string, number> }).layerDegradedUntil

    map.set('cleanup-layer', Date.now() - 1000)
    expect(map.has('cleanup-layer')).toBe(true)

    const skip = (cache as { shouldSkipLayer: (layer: CacheLayer) => boolean }).shouldSkipLayer(layer)

    expect(skip).toBe(false)
    expect(map.has('cleanup-layer')).toBe(false)
  })

  it('broadcasts L1 invalidation after mset when broadcastL1Invalidation is true', async () => {
    const bus = {
      subscribe: vi.fn(async () => vi.fn()),
      publish: vi.fn(async () => {})
    }
    const cache = new CacheStack([new MemoryLayer({ ttl: 60_000 })], {
      invalidationBus: bus,
      broadcastL1Invalidation: true
    })
    await cache.mset([
      { key: 'a', value: 1 },
      { key: 'b', value: 2 }
    ])
    expect(bus.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: 'keys',
        operation: 'write'
      })
    )
  })

  it('withTimeout returns raw value when result is not wrapped in {kind, value}', async () => {
    const cache = new CacheStack([new MemoryLayer({ ttl: 60_000 })])
    const withTimeout = (
      cache as unknown as {
        withTimeout: <T>(promise: Promise<T>, timeoutMs: number, onTimeout: () => Error) => Promise<T>
      }
    ).withTimeout.bind(cache)

    const result = await withTimeout(Promise.resolve(42), 1000, () => new Error('timeout'))
    expect(result).toBe(42)
  })

  it('scheduleBackgroundRefresh delegates to reader', async () => {
    const cache = new CacheStack([new MemoryLayer({ ttl: 60_000 })])
    const scheduleSpy = vi.fn()
    ;(
      cache as unknown as {
        reader: { runScheduleBackgroundRefresh: (...args: unknown[]) => void }
      }
    ).reader.runScheduleBackgroundRefresh = scheduleSpy
    ;(
      cache as unknown as {
        scheduleBackgroundRefresh: (
          key: string,
          fetcher: CacheFetcher<string>,
          options?: unknown,
          fetcherContext?: CacheFetcherContext<string>
        ) => void
      }
    ).scheduleBackgroundRefresh('key1', async () => 'val', { ttl: 30_000 })

    expect(scheduleSpy).toHaveBeenCalledWith('key1', expect.any(Function), { ttl: 30_000 }, undefined)
  })
})
