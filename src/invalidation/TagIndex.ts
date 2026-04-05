import type { CacheTagIndex } from '../types'
import { PatternMatcher } from './PatternMatcher'

interface TagIndexOptions {
  /**
   * Maximum number of keys tracked in `knownKeys`. When exceeded, the oldest
   * 10 % of keys are pruned to keep memory bounded.
   * Defaults to unlimited.
   */
  maxKnownKeys?: number
}

export class TagIndex implements CacheTagIndex {
  private readonly tagToKeys = new Map<string, Set<string>>()
  private readonly keyToTags = new Map<string, Set<string>>()
  private readonly knownKeys = new Set<string>()
  private readonly maxKnownKeys: number | undefined

  constructor(options: TagIndexOptions = {}) {
    this.maxKnownKeys = options.maxKnownKeys
  }

  async touch(key: string): Promise<void> {
    this.knownKeys.add(key)
    this.pruneKnownKeysIfNeeded()
  }

  async track(key: string, tags: string[]): Promise<void> {
    this.knownKeys.add(key)
    this.pruneKnownKeysIfNeeded()

    if (tags.length === 0) {
      return
    }

    const existingTags = this.keyToTags.get(key)
    if (existingTags) {
      for (const tag of existingTags) {
        this.tagToKeys.get(tag)?.delete(key)
      }
    }

    const tagSet = new Set(tags)
    this.keyToTags.set(key, tagSet)

    for (const tag of tagSet) {
      const keys = this.tagToKeys.get(tag) ?? new Set<string>()
      keys.add(key)
      this.tagToKeys.set(tag, keys)
    }
  }

  async remove(key: string): Promise<void> {
    this.removeKey(key)
  }

  async keysForTag(tag: string): Promise<string[]> {
    return [...(this.tagToKeys.get(tag) ?? new Set<string>())]
  }

  async keysForPrefix(prefix: string): Promise<string[]> {
    return [...this.knownKeys].filter((key) => key.startsWith(prefix))
  }

  async tagsForKey(key: string): Promise<string[]> {
    return [...(this.keyToTags.get(key) ?? new Set<string>())]
  }

  async matchPattern(pattern: string): Promise<string[]> {
    return [...this.knownKeys].filter((key) => PatternMatcher.matches(pattern, key))
  }

  async clear(): Promise<void> {
    this.tagToKeys.clear()
    this.keyToTags.clear()
    this.knownKeys.clear()
  }

  private pruneKnownKeysIfNeeded(): void {
    if (this.maxKnownKeys === undefined || this.knownKeys.size <= this.maxKnownKeys) {
      return
    }

    // Remove the oldest 10% of keys (Set iteration preserves insertion order)
    const toRemove = Math.ceil(this.maxKnownKeys * 0.1)
    let removed = 0
    for (const key of this.knownKeys) {
      if (removed >= toRemove) {
        break
      }
      this.removeKey(key)
      removed += 1
    }
  }

  private removeKey(key: string): void {
    this.knownKeys.delete(key)
    const tags = this.keyToTags.get(key)
    if (!tags) {
      return
    }

    for (const tag of tags) {
      const keys = this.tagToKeys.get(tag)
      if (!keys) {
        continue
      }

      keys.delete(key)
      if (keys.size === 0) {
        this.tagToKeys.delete(tag)
      }
    }

    this.keyToTags.delete(key)
  }
}
