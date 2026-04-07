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

  async collectKeysWithPrefix(prefix: string, maxMatches: number | false = false): Promise<string[]> {
    const { tagIndex } = this.options
    const matches = new Set<string>()

    if (tagIndex.forEachKeyForPrefix) {
      await tagIndex.forEachKeyForPrefix(prefix, async (key) => {
        matches.add(key)
        this.assertWithinMatchLimit(matches, maxMatches)
      })
    } else {
      const initialMatches = tagIndex.keysForPrefix
        ? await tagIndex.keysForPrefix(prefix)
        : await tagIndex.matchPattern(`${prefix}*`)
      for (const key of initialMatches) {
        matches.add(key)
        this.assertWithinMatchLimit(matches, maxMatches)
      }
    }

    await Promise.all(
      this.options.layers.map(async (layer) => {
        if ((!layer.keys && !layer.forEachKey) || this.options.shouldSkipLayer(layer)) {
          return
        }

        try {
          if (layer.forEachKey) {
            await layer.forEachKey(async (key) => {
              if (key.startsWith(prefix)) {
                matches.add(key)
                this.assertWithinMatchLimit(matches, maxMatches)
              }
            })
            return
          }

          const keys = await layer.keys?.()
          for (const key of keys ?? []) {
            if (key.startsWith(prefix)) {
              matches.add(key)
              this.assertWithinMatchLimit(matches, maxMatches)
            }
          }
        } catch (error) {
          await this.options.handleLayerFailure(layer, 'invalidate-prefix-scan', error)
        }
      })
    )

    return [...matches]
  }

  async collectKeysMatchingPattern(pattern: string, maxMatches: number | false = false): Promise<string[]> {
    const matches = new Set<string>()

    if (this.options.tagIndex.forEachKeyMatchingPattern) {
      await this.options.tagIndex.forEachKeyMatchingPattern(pattern, async (key) => {
        matches.add(key)
        this.assertWithinMatchLimit(matches, maxMatches)
      })
    } else {
      for (const key of await this.options.tagIndex.matchPattern(pattern)) {
        matches.add(key)
        this.assertWithinMatchLimit(matches, maxMatches)
      }
    }

    await Promise.all(
      this.options.layers.map(async (layer) => {
        if ((!layer.keys && !layer.forEachKey) || this.options.shouldSkipLayer(layer)) {
          return
        }

        try {
          if (layer.forEachKey) {
            await layer.forEachKey(async (key) => {
              if (PatternMatcher.matches(pattern, key)) {
                matches.add(key)
                this.assertWithinMatchLimit(matches, maxMatches)
              }
            })
            return
          }

          const keys = await layer.keys?.()
          for (const key of keys ?? []) {
            if (PatternMatcher.matches(pattern, key)) {
              matches.add(key)
              this.assertWithinMatchLimit(matches, maxMatches)
            }
          }
        } catch (error) {
          await this.options.handleLayerFailure(layer, 'invalidate-pattern-scan', error)
        }
      })
    )

    return [...matches]
  }

  private assertWithinMatchLimit(matches: Set<string>, maxMatches: number | false): void {
    if (maxMatches !== false && matches.size > maxMatches) {
      throw new Error(`Invalidation matched too many keys (${matches.size} > ${maxMatches}).`)
    }
  }
}
