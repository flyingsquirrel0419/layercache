import type { CacheTagIndex } from '../types'

interface TagIndexOptions {
  /**
   * Maximum number of keys tracked in `knownKeys`. When exceeded, the oldest
   * 10 % of keys are pruned to keep memory bounded.
   * Defaults to 100,000.
   */
  maxKnownKeys?: number
}

interface TrieNode {
  id: number
  terminal: boolean
  children: Map<string, TrieNode>
}

const MAX_PATTERN_RECURSION_DEPTH = 500

export class TagIndex implements CacheTagIndex {
  private readonly tagToKeys = new Map<string, Set<string>>()
  private readonly keyToTags = new Map<string, Set<string>>()
  private readonly knownKeys = new Map<string, number>()
  private readonly maxKnownKeys: number | undefined
  private nextNodeId = 1
  private readonly root = this.createTrieNode()

  constructor(options: TagIndexOptions = {}) {
    this.maxKnownKeys = options.maxKnownKeys ?? 100_000
  }

  /**
   * Records a key as known without changing tag assignments.
   */
  async touch(key: string): Promise<void> {
    this.insertKnownKey(key)
    this.pruneKnownKeysIfNeeded()
  }

  /**
   * Replaces the tags associated with a key and records the key as known.
   */
  async track(key: string, tags: string[]): Promise<void> {
    this.insertKnownKey(key)
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
    const matches = new Set<string>()
    this.collectPatternMatches(this.root, '', pattern, 0, matches, new Set<string>(), 0)
    return [...matches]
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

  private insertKnownKey(key: string): void {
    const isNew = !this.knownKeys.has(key)
    if (!isNew) {
      this.knownKeys.delete(key)
    }
    this.knownKeys.set(key, Date.now())

    if (!isNew) {
      return
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
    if (node.terminal) {
      matches.push(prefix)
    }

    for (const [character, child] of node.children) {
      this.collectFromNode(child, `${prefix}${character}`, matches)
    }
  }

  private async visitFromNode(
    node: TrieNode,
    prefix: string,
    visitor: (key: string) => void | Promise<void>
  ): Promise<void> {
    if (node.terminal) {
      await visitor(prefix)
    }

    for (const [character, child] of node.children) {
      await this.visitFromNode(child, `${prefix}${character}`, visitor)
    }
  }

  private collectPatternMatches(
    node: TrieNode,
    prefix: string,
    pattern: string,
    patternIndex: number,
    matches: Set<string>,
    visited: Set<string>,
    depth: number
  ): void {
    if (depth > MAX_PATTERN_RECURSION_DEPTH) {
      return
    }

    const stateKey = `${node.id}:${patternIndex}`
    if (visited.has(stateKey)) {
      return
    }
    visited.add(stateKey)

    if (patternIndex === pattern.length) {
      if (node.terminal) {
        matches.add(prefix)
      }
      return
    }

    const patternChar = pattern[patternIndex]
    if (patternChar === undefined) {
      return
    }
    if (patternChar === '*') {
      this.collectPatternMatches(node, prefix, pattern, patternIndex + 1, matches, visited, depth + 1)
      for (const [character, child] of node.children) {
        this.collectPatternMatches(child, `${prefix}${character}`, pattern, patternIndex, matches, visited, depth + 1)
      }
      return
    }

    if (patternChar === '?') {
      for (const [character, child] of node.children) {
        this.collectPatternMatches(
          child,
          `${prefix}${character}`,
          pattern,
          patternIndex + 1,
          matches,
          visited,
          depth + 1
        )
      }
      return
    }

    const child = node.children.get(patternChar)
    if (child) {
      this.collectPatternMatches(
        child,
        `${prefix}${patternChar}`,
        pattern,
        patternIndex + 1,
        matches,
        visited,
        depth + 1
      )
    }
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
      this.removeKey(oldestKey)
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
