import { PatternMatcher } from '../invalidation/PatternMatcher'
import type { CacheLayer, CacheTagIndex } from '../types'

interface CacheKeyDiscoveryOptions {
  layers: CacheLayer[]
  tagIndex: CacheTagIndex
  shouldSkipLayer: (layer: CacheLayer) => boolean
  handleLayerFailure: (layer: CacheLayer, operation: string, error: unknown) => Promise<void>
}

export class InvalidationLimitError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidationLimitError'
  }
}

export class CacheKeyDiscovery {
  constructor(private readonly options: CacheKeyDiscoveryOptions) {}

  async collectKeysWithPrefix(prefix: string, maxMatches: number | false = false): Promise<string[]> {
    const matches = new Set<string>()
    await this.forEachKeyWithPrefix(
      prefix,
      (key) => {
        matches.add(key)
      },
      maxMatches
    )

    return [...matches]
  }

  async forEachKeyWithPrefix(
    prefix: string,
    visitor: (key: string) => void | Promise<void>,
    maxMatches: number | false = false
  ): Promise<void> {
    const { tagIndex } = this.options
    const matches = new Set<string>()
    const visit = async (key: string): Promise<void> => {
      const previousSize = matches.size
      matches.add(key)
      if (matches.size === previousSize) {
        return
      }
      this.assertWithinMatchLimit(matches, maxMatches)
      await visitor(key)
    }

    if (tagIndex.forEachKeyForPrefix) {
      await tagIndex.forEachKeyForPrefix(prefix, async (key) => {
        await visit(key)
      })
    } else {
      const initialMatches = tagIndex.keysForPrefix
        ? await tagIndex.keysForPrefix(prefix)
        : await tagIndex.matchPattern(`${prefix}*`)
      for (const key of initialMatches) {
        await visit(key)
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
                await visit(key)
              }
            })
            return
          }

          const keys = await layer.keys?.()
          for (const key of keys ?? []) {
            if (key.startsWith(prefix)) {
              await visit(key)
            }
          }
        } catch (error) {
          if (error instanceof InvalidationLimitError) throw error
          await this.options.handleLayerFailure(layer, 'invalidate-prefix-scan', error)
        }
      })
    )
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
          if (error instanceof InvalidationLimitError) throw error
          await this.options.handleLayerFailure(layer, 'invalidate-pattern-scan', error)
        }
      })
    )

    return [...matches]
  }

  private assertWithinMatchLimit(matches: Set<string>, maxMatches: number | false): void {
    if (maxMatches !== false && matches.size > maxMatches) {
      throw new InvalidationLimitError(`Invalidation matched too many keys (${matches.size} > ${maxMatches}).`)
    }
  }
}
