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
    resolveLayerSeconds: vi.fn(() => undefined),
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
  })

  describe('executeLayerOperations - best-effort mode', () => {
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
