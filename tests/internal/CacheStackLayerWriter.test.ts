import { describe, expect, it, vi } from 'vitest'
import { CacheStackLayerWriter } from '../../src/internal/CacheStackLayerWriter'
import { CacheStackMaintenance } from '../../src/internal/CacheStackMaintenance'
import type { CacheLayer, CacheLayerSetManyEntry, LayerTtlMap } from '../../src/types'

function createMockLayer(name: string, overrides: Partial<CacheLayer> = {}): CacheLayer {
  return {
    name,
    isLocal: true,
    get: vi.fn(async () => null),
    set: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
    clear: vi.fn(async () => {}),
    ...overrides
  }
}

function createWriterOptions(overrides: Partial<Parameters<typeof CacheStackLayerWriter>[0]> = {}) {
  const maintenance = new CacheStackMaintenance()
  return {
    layers: [] as CacheLayer[],
    maintenance,
    shouldSkipLayer: vi.fn(() => false),
    shouldWriteBehind: vi.fn(() => false),
    handleLayerFailure: vi.fn(async () => {}),
    enqueueWriteBehind: vi.fn(async (op: () => Promise<void>) => {
      await op()
    }),
    resolveFreshTtl: vi.fn(() => 60),
    resolveLayerMs: vi.fn(() => undefined),
    globalStaleWhileRevalidate: undefined as number | LayerTtlMap | undefined,
    globalStaleIfError: undefined as number | LayerTtlMap | undefined,
    writePolicy: undefined as 'strict' | 'best-effort' | undefined,
    onWriteFailures: vi.fn(),
    ...overrides
  }
}

describe('CacheStackLayerWriter', () => {
  describe('writeAcrossLayers', () => {
    it('writes to all layers, skips degraded, delegates to write-behind for non-local layers', async () => {
      const localLayer = createMockLayer('local', { isLocal: true })
      const remoteLayer = createMockLayer('remote', { isLocal: false })
      const degradedLayer = createMockLayer('degraded')

      const options = createWriterOptions({
        layers: [localLayer, remoteLayer, degradedLayer],
        shouldSkipLayer: vi.fn((layer) => layer.name === 'degraded'),
        shouldWriteBehind: vi.fn((layer) => !layer.isLocal),
        enqueueWriteBehind: vi.fn(async (op) => {
          await op()
        })
      })

      const writer = new CacheStackLayerWriter(options)
      await writer.writeAcrossLayers('key1', 'value', { data: true })

      expect(localLayer.set).toHaveBeenCalledTimes(1)
      expect(remoteLayer.set).toHaveBeenCalledTimes(1)
      expect(degradedLayer.set).not.toHaveBeenCalled()
      expect(options.enqueueWriteBehind).toHaveBeenCalledTimes(1)
      expect(options.shouldWriteBehind).toHaveBeenCalledWith(remoteLayer)
    })

    it('rejects an explicitly stale write fence before touching layers', async () => {
      const layer = createMockLayer('stale')
      const maintenance = new CacheStackMaintenance()
      maintenance.bumpKeyEpochs(['key1'])
      const writer = new CacheStackLayerWriter(createWriterOptions({ layers: [layer], maintenance }))

      await expect(
        writer.writeAcrossLayers('key1', 'value', 'stale', undefined, { clearEpoch: 0, keyEpoch: 0 })
      ).resolves.toBe(false)
      expect(layer.set).not.toHaveBeenCalled()
    })

    it('reports cleanup failures after invalidation races a committed write', async () => {
      const maintenance = new CacheStackMaintenance()
      const layer = createMockLayer('cleanup-failure', {
        set: vi.fn(async () => {
          maintenance.bumpKeyEpochs(['key1'])
        }),
        delete: vi.fn(async () => {
          throw new Error('cleanup failed')
        })
      })
      const options = createWriterOptions({ layers: [layer], maintenance })
      const writer = new CacheStackLayerWriter(options)

      await expect(writer.writeAcrossLayers('key1', 'value', 'stale')).resolves.toBe(false)
      expect(options.handleLayerFailure).toHaveBeenCalledWith(layer, 'stale-write-cleanup', expect.any(Error))
    })

    it('cleans a write-behind layer when invalidation completes during its set', async () => {
      const maintenance = new CacheStackMaintenance()
      let releaseSet!: () => void
      let markStarted!: () => void
      const started = new Promise<void>((resolve) => {
        markStarted = resolve
      })
      const setGate = new Promise<void>((resolve) => {
        releaseSet = resolve
      })
      const layer = createMockLayer('remote', {
        isLocal: false,
        set: vi.fn(async () => {
          markStarted()
          await setGate
        })
      })
      const queued: Array<() => Promise<void>> = []
      const writer = new CacheStackLayerWriter(
        createWriterOptions({
          layers: [layer],
          maintenance,
          shouldWriteBehind: vi.fn(() => true),
          enqueueWriteBehind: vi.fn(async (operation) => {
            queued.push(operation)
          })
        })
      )

      await writer.writeAcrossLayers('key1', 'value', 'stale')
      const flush = queued[0]?.()
      await started
      maintenance.bumpKeyEpochs(['key1'])
      releaseSet()
      await flush

      expect(layer.delete).toHaveBeenCalledWith('key1')
    })
  })

  describe('writeBatch', () => {
    it('uses layer.setMany() when available', async () => {
      const setManyMock = vi.fn(async (_entries: CacheLayerSetManyEntry[]) => {})
      const layer = createMockLayer('bulk-layer', { setMany: setManyMock })

      const options = createWriterOptions({ layers: [layer] })
      const writer = new CacheStackLayerWriter(options)

      await writer.writeBatch([
        { key: 'a', value: 1 },
        { key: 'b', value: 2 }
      ])

      expect(setManyMock).toHaveBeenCalledTimes(1)
      const entries = setManyMock.mock.calls[0][0] as CacheLayerSetManyEntry[]
      expect(entries).toHaveLength(2)
      expect(entries.map((e: CacheLayerSetManyEntry) => e.key)).toEqual(['a', 'b'])
      expect(layer.set).not.toHaveBeenCalled()
    })

    it('skips degraded layers while constructing a batch', async () => {
      const skipped = createMockLayer('skipped')
      const active = createMockLayer('active')
      const writer = new CacheStackLayerWriter(
        createWriterOptions({
          layers: [skipped, active],
          shouldSkipLayer: vi.fn((layer) => layer === skipped)
        })
      )

      await writer.writeBatch([{ key: 'a', value: 1 }])

      expect(skipped.set).not.toHaveBeenCalled()
      expect(active.set).toHaveBeenCalledTimes(1)
    })

    it('drops a deferred batch after clear advances the epoch', async () => {
      const layer = createMockLayer('deferred')
      const maintenance = new CacheStackMaintenance()
      const deferred: Array<() => Promise<void>> = []
      const writer = new CacheStackLayerWriter(
        createWriterOptions({
          layers: [layer],
          maintenance,
          shouldWriteBehind: vi.fn(() => true),
          enqueueWriteBehind: vi.fn(async (operation) => {
            deferred.push(operation)
          })
        })
      )

      await writer.writeBatch([{ key: 'a', value: 1 }])
      maintenance.beginClearEpoch()
      await deferred[0]?.()

      expect(layer.set).not.toHaveBeenCalled()
    })

    it('skips operation when clear epoch changes mid-write (line 109)', async () => {
      const layer = createMockLayer('test-layer')
      const maintenance = new CacheStackMaintenance()

      const options = createWriterOptions({
        layers: [layer],
        maintenance
      })
      const writer = new CacheStackLayerWriter(options)

      const originalSet = layer.set as ReturnType<typeof vi.fn>
      originalSet.mockImplementation(async () => {
        maintenance.beginClearEpoch()
      })

      await writer.writeBatch([{ key: 'a', value: 1 }])

      expect(originalSet).toHaveBeenCalled()
    })

    it('skips operation when key epoch changes making activeEntries empty (line 115)', async () => {
      const layer = createMockLayer('epoch-layer')
      const maintenance = new CacheStackMaintenance()
      const deferredOps: Array<() => Promise<void>> = []

      maintenance.bumpKeyEpochs(['x', 'y'])

      const options = createWriterOptions({
        layers: [layer],
        maintenance,
        shouldWriteBehind: vi.fn(() => true),
        enqueueWriteBehind: vi.fn(async (op) => {
          deferredOps.push(op)
        })
      })
      const writer = new CacheStackLayerWriter(options)

      await writer.writeBatch([
        { key: 'x', value: 1 },
        { key: 'y', value: 2 }
      ])

      maintenance.bumpKeyEpochs(['x', 'y'])

      expect(deferredOps).toHaveLength(1)
      await deferredOps[0]()

      expect(layer.set).not.toHaveBeenCalled()
    })

    it('defers to write-behind queue for non-local layers (line 130)', async () => {
      const localLayer = createMockLayer('local-layer', { isLocal: true })
      const remoteLayer = createMockLayer('remote-layer', { isLocal: false })
      const writeBehindOps: Array<() => Promise<void>> = []

      const options = createWriterOptions({
        layers: [localLayer, remoteLayer],
        shouldWriteBehind: vi.fn((layer) => layer.name === 'remote-layer'),
        enqueueWriteBehind: vi.fn(async (op) => {
          writeBehindOps.push(op)
        })
      })
      const writer = new CacheStackLayerWriter(options)

      await writer.writeBatch([{ key: 'a', value: 1 }])

      expect(localLayer.set).toHaveBeenCalledTimes(1)
      expect(options.enqueueWriteBehind).toHaveBeenCalledTimes(1)
      expect(remoteLayer.set).not.toHaveBeenCalled()

      expect(writeBehindOps).toHaveLength(1)
      await writeBehindOps[0]()
      expect(remoteLayer.set).toHaveBeenCalledTimes(1)
    })

    it('serializes a newer batch write after stale single-write cleanup', async () => {
      const maintenance = new CacheStackMaintenance()
      const stored = new Map<string, unknown>()
      let releaseOldSet!: () => void
      let markOldStarted!: () => void
      const oldStarted = new Promise<void>((resolve) => {
        markOldStarted = resolve
      })
      const oldSetGate = new Promise<void>((resolve) => {
        releaseOldSet = resolve
      })
      let setCalls = 0
      const layer = createMockLayer('ordered', {
        set: vi.fn(async (key, value) => {
          setCalls += 1
          stored.set(key, value)
          if (setCalls === 1) {
            markOldStarted()
            await oldSetGate
          }
        }),
        setMany: vi.fn(async (entries: CacheLayerSetManyEntry[]) => {
          for (const entry of entries) stored.set(entry.key, entry.value)
        }),
        delete: vi.fn(async (key) => {
          stored.delete(key)
        })
      })
      const writer = new CacheStackLayerWriter(createWriterOptions({ layers: [layer], maintenance }))

      const oldWrite = writer.writeAcrossLayers('key1', 'value', 'old')
      await oldStarted
      maintenance.bumpKeyEpochs(['key1'])
      const newerBatch = writer.writeBatch([{ key: 'key1', value: 'new' }])

      releaseOldSet()
      await Promise.all([oldWrite, newerBatch])

      expect(stored.has('key1')).toBe(true)
      expect(layer.setMany).toHaveBeenCalledTimes(1)
      expect(layer.delete).toHaveBeenCalledBefore(layer.setMany as ReturnType<typeof vi.fn>)
    })
  })

  describe('executeLayerOperations - best-effort mode', () => {
    it('completes without failure reporting when every layer succeeds', async () => {
      const options = createWriterOptions({
        layers: [createMockLayer('one'), createMockLayer('two')],
        writePolicy: 'best-effort'
      })
      const writer = new CacheStackLayerWriter(options)

      await expect(writer.writeAcrossLayers('key1', 'value', 'data')).resolves.toBe(true)
      expect(options.onWriteFailures).not.toHaveBeenCalled()
    })

    it('handles partial failure with onWriteFailures called and no throw', async () => {
      const failLayer = createMockLayer('fail-layer', {
        set: vi.fn(async () => {
          throw new Error('layer down')
        })
      })
      const okLayer = createMockLayer('ok-layer')

      const options = createWriterOptions({
        layers: [failLayer, okLayer],
        writePolicy: 'best-effort',
        handleLayerFailure: vi.fn(async (_layer: CacheLayer, _op: string, error: unknown) => {
          throw error
        })
      })
      const writer = new CacheStackLayerWriter(options)

      await writer.writeAcrossLayers('key1', 'value', 'data')
      expect(options.onWriteFailures).toHaveBeenCalledWith({ key: 'key1', action: 'set' }, [expect.any(Error)])
    })

    it('throws AggregateError when all layers fail (line 164-168)', async () => {
      const failLayer1 = createMockLayer('fail1', {
        set: vi.fn(async () => {
          throw new Error('fail1')
        })
      })
      const failLayer2 = createMockLayer('fail2', {
        set: vi.fn(async () => {
          throw new Error('fail2')
        })
      })

      const options = createWriterOptions({
        layers: [failLayer1, failLayer2],
        writePolicy: 'best-effort',
        handleLayerFailure: vi.fn(async (_layer: CacheLayer, _op: string, error: unknown) => {
          throw error
        })
      })
      const writer = new CacheStackLayerWriter(options)

      await expect(writer.writeAcrossLayers('key1', 'value', 'data')).rejects.toThrow(AggregateError)

      expect(options.onWriteFailures).toHaveBeenCalled()
    })
  })

  describe('executeLayerOperations - strict mode', () => {
    it('propagates failures immediately without Promise.allSettled', async () => {
      const failLayer = createMockLayer('fail-strict', {
        set: vi.fn(async () => {
          throw new Error('strict fail')
        })
      })
      const okLayer = createMockLayer('ok-strict')

      const options = createWriterOptions({
        layers: [failLayer, okLayer],
        writePolicy: 'strict',
        handleLayerFailure: vi.fn(async (_layer: CacheLayer, _op: string, error: unknown) => {
          throw error
        })
      })
      const writer = new CacheStackLayerWriter(options)

      // Strict mode: error propagates immediately, onWriteFailures not called
      await expect(writer.writeAcrossLayers('key1', 'value', 'data')).rejects.toThrow('strict fail')

      expect(options.onWriteFailures).not.toHaveBeenCalled()
    })
  })
})
