import { PatternMatcher } from '../invalidation/PatternMatcher'
import type { CacheLayer, CacheTagIndex } from '../types'

interface CacheKeyDiscoveryOptions {
  layers: CacheLayer[]
  tagIndex: CacheTagIndex
  shouldSkipLayer: (layer: CacheLayer) => boolean
  handleLayerFailure: (layer: CacheLayer, operation: string, error: unknown) => Promise<void>
}

export class CacheKeyDiscovery {
  constructor(private readonly options: CacheKeyDiscoveryOptions) {}

  async collectKeysWithPrefix(prefix: string): Promise<string[]> {
    const { tagIndex } = this.options
    const matches = new Set(
      tagIndex.keysForPrefix ? await tagIndex.keysForPrefix(prefix) : await tagIndex.matchPattern(`${prefix}*`)
    )

    await Promise.all(
      this.options.layers.map(async (layer) => {
        if (!layer.keys || this.options.shouldSkipLayer(layer)) {
          return
        }

        try {
          const keys = await layer.keys()
          for (const key of keys) {
            if (key.startsWith(prefix)) {
              matches.add(key)
            }
          }
        } catch (error) {
          await this.options.handleLayerFailure(layer, 'invalidate-prefix-scan', error)
        }
      })
    )

    return [...matches]
  }

  async collectKeysMatchingPattern(pattern: string): Promise<string[]> {
    const matches = new Set(await this.options.tagIndex.matchPattern(pattern))

    await Promise.all(
      this.options.layers.map(async (layer) => {
        if (!layer.keys || this.options.shouldSkipLayer(layer)) {
          return
        }

        try {
          const keys = await layer.keys()
          for (const key of keys) {
            if (PatternMatcher.matches(pattern, key)) {
              matches.add(key)
            }
          }
        } catch (error) {
          await this.options.handleLayerFailure(layer, 'invalidate-pattern-scan', error)
        }
      })
    )

    return [...matches]
  }
}
