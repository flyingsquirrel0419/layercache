import type { CacheTagIndex } from '../types'
import { PatternMatcher } from './PatternMatcher'

export class TagIndex implements CacheTagIndex {
  private readonly tagToKeys = new Map<string, Set<string>>()
  private readonly keyToTags = new Map<string, Set<string>>()
  private readonly knownKeys = new Set<string>()

  async touch(key: string): Promise<void> {
    this.knownKeys.add(key)
  }

  async track(key: string, tags: string[]): Promise<void> {
    this.knownKeys.add(key)

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

  async keysForTag(tag: string): Promise<string[]> {
    return [...(this.tagToKeys.get(tag) ?? new Set<string>())]
  }

  async matchPattern(pattern: string): Promise<string[]> {
    return [...this.knownKeys].filter((key) => PatternMatcher.matches(pattern, key))
  }

  async clear(): Promise<void> {
    this.tagToKeys.clear()
    this.keyToTags.clear()
    this.knownKeys.clear()
  }
}
