import type { CacheLayer, CacheLayerSetManyEntry, CacheWriteOptions, LayerTtlMap } from '../types'
import type { CacheStackMaintenance } from './CacheStackMaintenance'
import { createStoredValueEnvelope, remainingStoredTtlMs } from './StoredValue'

export type CacheWriteKind = 'value' | 'empty'

interface CacheStackLayerWriterOptions {
  layers: CacheLayer[]
  maintenance: CacheStackMaintenance
  shouldSkipLayer: (layer: CacheLayer) => boolean
  shouldWriteBehind: (layer: CacheLayer) => boolean
  handleLayerFailure: (layer: CacheLayer, operation: string, error: unknown) => Promise<void>
  enqueueWriteBehind: (operation: () => Promise<void>) => Promise<void>
  resolveFreshTtl: (
    key: string,
    layerName: string,
    kind: CacheWriteKind,
    options: CacheWriteOptions | undefined,
    fallbackTtl: number | undefined,
    value: unknown
  ) => number | undefined
  resolveLayerMs: (
    layerName: string,
    override: number | LayerTtlMap | undefined,
    globalDefault?: number | LayerTtlMap,
    fallback?: number
  ) => number | undefined
  globalStaleWhileRevalidate: number | LayerTtlMap | undefined
  globalStaleIfError: number | LayerTtlMap | undefined
  writePolicy: 'strict' | 'best-effort' | undefined
  onWriteFailures: (context: { key: string; action: string }, failures: unknown[]) => void
}

interface LayerBatchEntry {
  key: string
  value: unknown
  options?: CacheWriteOptions
}

export interface CacheWriteFence {
  clearEpoch: number
  keyEpoch: number
}

export class CacheStackLayerWriter {
  constructor(private readonly options: CacheStackLayerWriterOptions) {}

  async writeAcrossLayers(
    key: string,
    kind: CacheWriteKind,
    value: unknown,
    writeOptions?: CacheWriteOptions,
    fence?: CacheWriteFence
  ): Promise<boolean> {
    const now = Date.now()
    const clearEpoch = fence?.clearEpoch ?? this.options.maintenance.currentClearEpoch()
    const keyEpoch = fence?.keyEpoch ?? this.options.maintenance.currentKeyEpoch(key)
    const immediateOperations: Array<() => Promise<void>> = []
    const deferredOperations: Array<{ layer: CacheLayer; operation: () => Promise<void> }> = []

    for (const layer of this.options.layers) {
      const operation = async () => {
        if (this.options.maintenance.isWriteOutdated(key, clearEpoch, keyEpoch)) {
          return
        }
        if (this.options.shouldSkipLayer(layer)) {
          return
        }

        const entry = this.buildLayerSetEntry(layer, key, kind, value, writeOptions, now)
        try {
          await layer.set(entry.key, entry.value, entry.ttl)
        } catch (error) {
          await this.options.handleLayerFailure(layer, 'write', error)
        }
      }

      if (this.options.shouldWriteBehind(layer)) {
        deferredOperations.push({ layer, operation })
      } else {
        immediateOperations.push(operation)
      }
    }

    const immediateLayers = this.options.layers.filter(
      (layer) => !this.options.shouldSkipLayer(layer) && !this.options.shouldWriteBehind(layer)
    )
    const committed = await this.options.maintenance.runFencedWrite(
      key,
      clearEpoch,
      keyEpoch,
      () =>
        this.executeLayerOperations(immediateOperations, { key, action: kind === 'empty' ? 'negative-set' : 'set' }),
      () => this.deleteFromLayers(key, immediateLayers)
    )
    await Promise.all(
      deferredOperations.map(({ layer, operation }) =>
        this.options.enqueueWriteBehind(async () => {
          await this.options.maintenance.runFencedWrite(key, clearEpoch, keyEpoch, operation, () =>
            this.deleteFromLayers(key, [layer])
          )
        })
      )
    )
    return committed
  }

  private async deleteFromLayers(key: string, layers: CacheLayer[]): Promise<void> {
    await Promise.all(
      layers.map(async (layer) => {
        try {
          await layer.delete(key)
        } catch (error) {
          await this.options.handleLayerFailure(layer, 'stale-write-cleanup', error)
        }
      })
    )
  }

  async writeBatch(entries: LayerBatchEntry[]): Promise<{ clearEpoch: number; entryEpochs: Map<string, number> }> {
    const now = Date.now()
    const clearEpoch = this.options.maintenance.currentClearEpoch()
    const entryEpochs = new Map(
      entries.map((entry) => [entry.key, this.options.maintenance.currentKeyEpoch(entry.key)])
    )
    const entriesByLayer = new Map<CacheLayer, CacheLayerSetManyEntry[]>()
    const immediateOperations: Array<() => Promise<void>> = []
    const deferredOperations: Array<() => Promise<void>> = []

    for (const entry of entries) {
      for (const layer of this.options.layers) {
        if (this.options.shouldSkipLayer(layer)) {
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
        if (clearEpoch !== this.options.maintenance.currentClearEpoch()) {
          return
        }
        const activeEntries = layerEntries.filter(
          (entry) => (entryEpochs.get(entry.key) ?? 0) === this.options.maintenance.currentKeyEpoch(entry.key)
        )
        if (activeEntries.length === 0) {
          return
        }
        try {
          if (layer.setMany) {
            await layer.setMany(activeEntries)
          } else {
            await Promise.all(activeEntries.map((entry) => layer.set(entry.key, entry.value, entry.ttl)))
          }
        } catch (error) {
          await this.options.handleLayerFailure(layer, 'write', error)
        }

        // A fence can change while the backend write is in flight. Remove only
        // from this layer so that stale completion cannot repopulate the key.
        const staleKeys = activeEntries
          .filter((entry) =>
            this.options.maintenance.isWriteOutdated(entry.key, clearEpoch, entryEpochs.get(entry.key))
          )
          .map((entry) => entry.key)
        if (staleKeys.length > 0) {
          await this.deleteKeysFromLayer(staleKeys, layer)
        }
      }

      if (this.options.shouldWriteBehind(layer)) {
        deferredOperations.push(operation)
      } else {
        immediateOperations.push(operation)
      }
    }

    const keys = entries.map((entry) => entry.key)
    await this.options.maintenance.runSerializedWrites(keys, () =>
      this.executeLayerOperations(immediateOperations, { key: 'batch', action: 'mset' })
    )
    await Promise.all(
      deferredOperations.map((operation) =>
        this.options.enqueueWriteBehind(async () => {
          await this.options.maintenance.runSerializedWrites(keys, operation)
        })
      )
    )
    return { clearEpoch, entryEpochs }
  }

  private async deleteKeysFromLayer(keys: string[], layer: CacheLayer): Promise<void> {
    await Promise.all(keys.map((key) => this.deleteFromLayers(key, [layer])))
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
    const degraded = results.filter((result): result is PromiseFulfilledResult<void> => result.status === 'fulfilled')
    if (failures.length === 0) {
      return
    }

    this.options.onWriteFailures(
      context,
      failures.map((failure) => failure.reason)
    )

    // Throw when every layer either rejected or was fulfilled via graceful degradation
    // (handleLayerFailure returns null without re-throwing). Both paths indicate actual failure.
    if (failures.length === operations.length) {
      throw new AggregateError(
        failures.map((failure) => failure.reason),
        `${context.action} failed for every cache layer`
      )
    }
  }

  private buildLayerSetEntry(
    layer: CacheLayer,
    key: string,
    kind: CacheWriteKind,
    value: unknown,
    writeOptions: CacheWriteOptions | undefined,
    now: number
  ): CacheLayerSetManyEntry {
    const freshTtl = this.options.resolveFreshTtl(key, layer.name, kind, writeOptions, layer.defaultTtl, value)
    const staleWhileRevalidate = this.options.resolveLayerMs(
      layer.name,
      writeOptions?.staleWhileRevalidate,
      this.options.globalStaleWhileRevalidate
    )
    const staleIfError = this.options.resolveLayerMs(
      layer.name,
      writeOptions?.staleIfError,
      this.options.globalStaleIfError
    )
    const payload = createStoredValueEnvelope({
      kind,
      value,
      freshTtlMs: freshTtl,
      staleWhileRevalidateMs: staleWhileRevalidate,
      staleIfErrorMs: staleIfError,
      now
    })
    const ttl = remainingStoredTtlMs(payload, now) ?? freshTtl
    return {
      key,
      value: payload,
      ttl
    }
  }
}
