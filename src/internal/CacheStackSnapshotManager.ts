import { constants, promises as fs } from 'node:fs'
import type { CacheLayer, CacheSerializer, CacheSnapshotEntry, CacheTagIndex } from '../types'
import {
  atomicWriteTempPath,
  commitAtomicWrite,
  readUtf8HandleWithLimit,
  validateSnapshotFilePath
} from './CacheSnapshotFile'
import { remainingStoredTtlMs } from './StoredValue'
import { sanitizeStructuredData } from './StructuredDataSanitizer'

const DEFAULT_SNAPSHOT_IMPORT_BATCH_SIZE = 50

interface CacheStackSnapshotManagerOptions {
  layers: CacheLayer[]
  tagIndex: CacheTagIndex
  snapshotSerializer: CacheSerializer
  readLayerEntry: (layer: CacheLayer, key: string) => Promise<unknown | null>
  shouldSkipLayer: (layer: CacheLayer) => boolean
  handleLayerFailure: (layer: CacheLayer, operation: string, error: unknown) => Promise<null>
  qualifyKey: (key: string) => string
  stripQualifiedKey: (key: string) => string
  validateCacheKey: (key: string) => string
  formatError: (error: unknown) => string
}

export class CacheStackSnapshotManager {
  constructor(private readonly options: CacheStackSnapshotManagerOptions) {}

  async exportState(maxEntries: number | false): Promise<CacheSnapshotEntry[]> {
    const entries: CacheSnapshotEntry[] = []
    await this.visitExportEntries(maxEntries, async (entry) => {
      entries.push(entry)
    })
    return entries
  }

  async importState(entries: CacheSnapshotEntry[]): Promise<void> {
    const normalizedEntries = entries.map((entry) => ({
      key: this.options.qualifyKey(this.options.validateCacheKey(entry.key)),
      value: entry.value,
      ttl: entry.ttl
    }))

    for (let index = 0; index < normalizedEntries.length; index += DEFAULT_SNAPSHOT_IMPORT_BATCH_SIZE) {
      const batch = normalizedEntries.slice(index, index + DEFAULT_SNAPSHOT_IMPORT_BATCH_SIZE)
      await Promise.all(
        batch.map(async (entry) => {
          await Promise.all(
            this.options.layers.map(async (layer) => {
              if (this.options.shouldSkipLayer(layer)) return
              try {
                await layer.set(entry.key, entry.value, entry.ttl)
              } catch (error) {
                await this.options.handleLayerFailure(layer, 'write', error)
              }
            })
          )
          await this.options.tagIndex.touch(entry.key)
        })
      )
    }
  }

  async persistToFile(
    filePath: string,
    snapshotBaseDir: string | false | undefined,
    maxEntries: number | false
  ): Promise<void> {
    const targetPath = await validateSnapshotFilePath(filePath, 'write', snapshotBaseDir)
    const tempPath = atomicWriteTempPath(targetPath)
    let handle: import('node:fs/promises').FileHandle | undefined

    try {
      handle = await fs.open(tempPath, 'wx')
      const openedHandle = handle
      await openedHandle.writeFile('[', 'utf8')

      let wroteAny = false
      await this.visitExportEntries(maxEntries, async (entry) => {
        await openedHandle.writeFile(wroteAny ? ',\n' : '\n', 'utf8')
        await openedHandle.writeFile(JSON.stringify(entry, null, 2), 'utf8')
        wroteAny = true
      })

      await openedHandle.writeFile(wroteAny ? '\n]' : ']', 'utf8')
      await openedHandle.close()
      handle = undefined
      await commitAtomicWrite(tempPath, targetPath)
    } catch (error) {
      await handle?.close().catch(() => undefined)
      await fs.unlink(tempPath).catch(() => undefined)
      throw error
    }
  }

  async restoreFromFile(
    filePath: string,
    snapshotBaseDir: string | false | undefined,
    maxBytes: number | false
  ): Promise<void> {
    const validatedPath = await validateSnapshotFilePath(filePath, 'read', snapshotBaseDir)
    /* v8 ignore next -- O_NOFOLLOW is available in supported Node runtimes */
    const handle = await fs.open(validatedPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    let raw: string
    try {
      if (maxBytes !== false) {
        const stat = await handle.stat()
        if (stat.size > maxBytes) {
          throw new Error(`Snapshot file exceeds snapshotMaxBytes limit (${stat.size} bytes > ${maxBytes} bytes).`)
        }
      }

      raw = await readUtf8HandleWithLimit(handle, maxBytes)
    } finally {
      await handle.close()
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (cause) {
      throw new Error(`Invalid snapshot file: could not parse JSON (${this.options.formatError(cause)})`)
    }

    if (!this.isCacheSnapshotEntries(parsed)) {
      throw new Error('Invalid snapshot file: expected an array of { key: string, value, ttl? } entries')
    }

    await this.importState(
      /* v8 ignore next -- restore mapping is covered through public restoreFromFile behavior */
      parsed.map((entry) => ({
        key: entry.key,
        value: this.sanitizeSnapshotValue(entry.value),
        ttl: entry.ttl
      }))
    )
  }

  async visitExportEntries(
    maxEntries: number | false,
    visitor: (entry: CacheSnapshotEntry) => Promise<void> | void
  ): Promise<void> {
    const exported = new Set<string>()

    for (const layer of this.options.layers) {
      if (!layer.keys && !layer.forEachKey) {
        continue
      }

      const visitKey = async (key: string): Promise<void> => {
        const exportedKey = this.options.stripQualifiedKey(key)
        if (exported.has(exportedKey)) {
          return
        }

        const stored = await this.options.readLayerEntry(layer, key)
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
          ttl: remainingStoredTtlMs(stored)
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
    // Always run explicit sanitization to ensure prototype-pollution protection
    // even when a custom serializer is used that does not call sanitizeStructuredData.
    const roundTripped = this.options.snapshotSerializer.deserialize(this.options.snapshotSerializer.serialize(value))
    return sanitizeStructuredData(roundTripped, {
      label: 'Snapshot value',
      maxDepth: 64,
      maxNodes: 10_000,
      /* v8 ignore next -- sanitizer object factory is exercised indirectly by structured data tests */
      createObject: () => Object.create(null) as Record<string, unknown>
    })
  }
}
