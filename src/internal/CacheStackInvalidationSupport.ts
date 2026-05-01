import type { CacheLayer, CacheTagIndex } from '../types'
import { expireStoredEnvelope, remainingStoredTtlMs } from './StoredValue'

interface CacheStackInvalidationSupportOptions {
  tagIndex: CacheTagIndex
  shouldSkipLayer: (layer: CacheLayer) => boolean
  handleLayerFailure: (layer: CacheLayer, operation: string, error: unknown) => Promise<void>
}

export class CacheStackInvalidationSupport {
  constructor(private readonly options: CacheStackInvalidationSupportOptions) {}

  async collectKeysForTag(tag: string, maxKeys: number | false): Promise<string[]> {
    const keys = new Set<string>()

    if (this.options.tagIndex.forEachKeyForTag) {
      await this.options.tagIndex.forEachKeyForTag(tag, async (key) => {
        keys.add(key)
        this.assertWithinInvalidationKeyLimit(keys.size, maxKeys)
      })
      return [...keys]
    }

    for (const key of await this.options.tagIndex.keysForTag(tag)) {
      keys.add(key)
      this.assertWithinInvalidationKeyLimit(keys.size, maxKeys)
    }

    return [...keys]
  }

  intersectKeys(groups: string[][]): string[] {
    if (groups.length === 0) {
      return []
    }

    const [firstGroup, ...rest] = groups
    const restSets = rest.map((group) => new Set(group))
    return [...new Set(firstGroup)].filter((key) => restSets.every((group) => group.has(key)))
  }

  async deleteKeysFromLayers(layers: CacheLayer[], keys: string[]): Promise<void> {
    await Promise.all(
      layers.map(async (layer) => {
        if (this.options.shouldSkipLayer(layer)) {
          return
        }

        if (layer.deleteMany) {
          try {
            await layer.deleteMany(keys)
          } catch (error) {
            await this.options.handleLayerFailure(layer, 'delete', error)
          }
          return
        }

        await Promise.all(
          keys.map(async (key) => {
            try {
              await layer.delete(key)
            } catch (error) {
              await this.options.handleLayerFailure(layer, 'delete', error)
            }
          })
        )
      })
    )
  }

  async expireKeysInLayers(layers: CacheLayer[], keys: string[]): Promise<Set<string>> {
    const foundKeys = new Set<string>()

    await Promise.all(
      layers.map(async (layer) => {
        if (this.options.shouldSkipLayer(layer)) {
          return
        }

        await Promise.all(
          keys.map(async (key) => {
            try {
              const stored = layer.getEntry ? await layer.getEntry(key) : await layer.get(key)
              if (stored === null) {
                return
              }

              foundKeys.add(key)
              const expired = expireStoredEnvelope(stored)
              if (expired === stored) {
                return
              }

              await layer.set(key, expired, remainingStoredTtlMs(expired))
            } catch (error) {
              await this.options.handleLayerFailure(layer, 'expire', error)
            }
          })
        )
      })
    )

    return foundKeys
  }

  assertWithinInvalidationKeyLimit(size: number, maxKeys: number | false): void {
    if (maxKeys !== false && size > maxKeys) {
      throw new Error(`Invalidation matched too many keys (${size} > ${maxKeys}).`)
    }
  }
}
