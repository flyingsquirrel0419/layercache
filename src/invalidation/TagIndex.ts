import type { CacheTagIndex } from '../types'
import { PatternMatcher } from './PatternMatcher'

interface TagIndexOptions {
  /**
   * Maximum number of keys tracked in `knownKeys`. When exceeded, the oldest
   * 10 % of keys are pruned to keep memory bounded.
   * Defaults to 100,000.
   */
  maxKnownKeys?: number
  /**
   * Minimum age before an existing key touch refreshes LRU order.
   * Defaults to 1000ms to avoid delete/set churn on cache-hit hot paths.
   */
  touchRefreshIntervalMs?: number
}

interface TrieNode {
  id: number
  terminal: boolean
  children: Map<string, TrieNode>
}

const DEFAULT_TOUCH_REFRESH_INTERVAL_MS = 1_000
export class TagIndex implements CacheTagIndex {
  private readonly tagToKeys = new Map<string, Set<string>>()
  private readonly keyToTags = new Map<string, Set<string>>()
  private readonly knownKeys = new Map<string, number>()
  private readonly maxKnownKeys: number | undefined
  private readonly touchRefreshIntervalMs: number
  private nextNodeId = 1
  private readonly root = this.createTrieNode()

  constructor(options: TagIndexOptions = {}) {
    this.maxKnownKeys = options.maxKnownKeys ?? 100_000
    this.touchRefreshIntervalMs = options.touchRefreshIntervalMs ?? DEFAULT_TOUCH_REFRESH_INTERVAL_MS
  }

  /**
   * Records a key as known without changing tag assignments.
   */
  async touch(key: string): Promise<void> {
    if (this.insertKnownKey(key)) {
      this.pruneKnownKeysIfNeeded()
    }
  }

  /**
   * Replaces the tags associated with a key and records the key as known.
   */
  async track(key: string, tags: string[]): Promise<void> {
    if (this.insertKnownKey(key)) {
      this.pruneKnownKeysIfNeeded()
    }

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

  /**
   * Removes a key from all tag mappings and known-key tracking.
   */
  async remove(key: string): Promise<void> {
    this.removeKey(key)
  }

  /**
   * Returns keys currently associated with a tag.
   */
  async keysForTag(tag: string): Promise<string[]> {
    return [...(this.tagToKeys.get(tag) ?? new Set<string>())]
  }

  /**
   * Visits keys currently associated with a tag.
   */
  async forEachKeyForTag(tag: string, visitor: (key: string) => void | Promise<void>): Promise<void> {
    for (const key of this.tagToKeys.get(tag) ?? new Set<string>()) {
      await visitor(key)
    }
  }

  /**
   * Returns known keys that start with a prefix.
   */
  async keysForPrefix(prefix: string): Promise<string[]> {
    const node = this.findNode(prefix)
    if (!node) {
      return []
    }

    const matches: string[] = []
    this.collectFromNode(node, prefix, matches)
    return matches
  }

  /**
   * Visits known keys that start with a prefix.
   */
  async forEachKeyForPrefix(prefix: string, visitor: (key: string) => void | Promise<void>): Promise<void> {
    const node = this.findNode(prefix)
    if (!node) {
      return
    }

    await this.visitFromNode(node, prefix, visitor)
  }

  /**
   * Returns the tags currently associated with a key.
   */
  async tagsForKey(key: string): Promise<string[]> {
    return [...(this.keyToTags.get(key) ?? new Set<string>())]
  }

  /**
   * Returns known keys matching a wildcard pattern.
   */
  async matchPattern(pattern: string): Promise<string[]> {
    const literalPrefix = this.literalPrefix(pattern)
    const node = this.findNode(literalPrefix)
    if (!node) {
      return []
    }

    const candidates: string[] = []
    this.collectFromNode(node, literalPrefix, candidates)
    return candidates.filter((key) => PatternMatcher.matches(pattern, key))
  }

  /**
   * Visits known keys matching a wildcard pattern.
   */
  async forEachKeyMatchingPattern(pattern: string, visitor: (key: string) => void | Promise<void>): Promise<void> {
    const matches = await this.matchPattern(pattern)
    for (const key of matches) {
      await visitor(key)
    }
  }

  /**
   * Clears all tag and known-key index state.
   */
  async clear(): Promise<void> {
    this.tagToKeys.clear()
    this.keyToTags.clear()
    this.knownKeys.clear()
    this.root.children.clear()
    this.root.terminal = false
    this.nextNodeId = this.root.id + 1
  }

  private createTrieNode(): TrieNode {
    return {
      id: this.nextNodeId++,
      terminal: false,
      children: new Map<string, TrieNode>()
    }
  }

  private insertKnownKey(key: string): boolean {
    const previousTouch = this.knownKeys.get(key)
    const isNew = previousTouch === undefined
    const now = Date.now()
    if (!isNew && now - previousTouch < this.touchRefreshIntervalMs) {
      return false
    }

    if (!isNew) {
      this.knownKeys.delete(key)
    }
    this.knownKeys.set(key, now)

    if (!isNew) {
      return true
    }

    let node = this.root
    for (const character of key) {
      let child = node.children.get(character)
      if (!child) {
        child = this.createTrieNode()
        node.children.set(character, child)
      }
      node = child
    }
    node.terminal = true
    return true
  }

  private findNode(prefix: string): TrieNode | undefined {
    let node: TrieNode | undefined = this.root
    for (const character of prefix) {
      node = node.children.get(character)
      if (!node) {
        return undefined
      }
    }
    return node
  }

  private collectFromNode(node: TrieNode, prefix: string, matches: string[]): void {
    const stack: Array<{ node: TrieNode; prefix: string }> = [{ node, prefix }]
    while (stack.length > 0) {
      const current = stack.pop()
      if (!current) {
        continue
      }
      if (current.node.terminal) {
        matches.push(current.prefix)
      }

      const children = [...current.node.children].reverse()
      for (const [character, child] of children) {
        stack.push({ node: child, prefix: `${current.prefix}${character}` })
      }
    }
  }

  private async visitFromNode(
    node: TrieNode,
    prefix: string,
    visitor: (key: string) => void | Promise<void>
  ): Promise<void> {
    const stack: Array<{ node: TrieNode; prefix: string }> = [{ node, prefix }]
    while (stack.length > 0) {
      const current = stack.pop()
      if (!current) {
        continue
      }
      if (current.node.terminal) {
        await visitor(current.prefix)
      }

      const children = [...current.node.children].reverse()
      for (const [character, child] of children) {
        stack.push({ node: child, prefix: `${current.prefix}${character}` })
      }
    }
  }

  private literalPrefix(pattern: string): string {
    const wildcardIndex = pattern.search(/[*?]/)
    return wildcardIndex === -1 ? pattern : pattern.slice(0, wildcardIndex)
  }

  private pruneKnownKeysIfNeeded(): void {
    if (this.maxKnownKeys === undefined || this.knownKeys.size <= this.maxKnownKeys) {
      return
    }

    const toRemove = Math.ceil(this.maxKnownKeys * 0.1)
    for (let i = 0; i < toRemove; i += 1) {
      const oldestKey = this.knownKeys.keys().next().value
      if (oldestKey === undefined) {
        break
      }
      this.removeKnownKey(oldestKey)
    }
  }

  private removeKey(key: string): void {
    this.removeKnownKey(key)

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

  private removeKnownKey(key: string): void {
    if (!this.knownKeys.delete(key)) {
      return
    }

    const path: Array<[TrieNode, string]> = []
    let node = this.root
    for (const character of key) {
      const child = node.children.get(character)
      if (!child) {
        return
      }
      path.push([node, character])
      node = child
    }

    node.terminal = false

    for (let index = path.length - 1; index >= 0; index -= 1) {
      const entry = path[index]
      if (!entry) {
        continue
      }
      const [parent, character] = entry
      const child = parent.children.get(character)
      if (!child || child.terminal || child.children.size > 0) {
        break
      }
      parent.children.delete(character)
    }
  }
}
