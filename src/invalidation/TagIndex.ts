import type { CacheTagIndex } from '../types'

interface TagIndexOptions {
  /**
   * Maximum number of keys tracked in `knownKeys`. When exceeded, the oldest
   * 10 % of keys are pruned to keep memory bounded.
   * Defaults to unlimited.
   */
  maxKnownKeys?: number
}

interface TrieNode {
  id: number
  terminal: boolean
  children: Map<string, TrieNode>
}

export class TagIndex implements CacheTagIndex {
  private readonly tagToKeys = new Map<string, Set<string>>()
  private readonly keyToTags = new Map<string, Set<string>>()
  private readonly knownKeys = new Set<string>()
  private readonly maxKnownKeys: number | undefined
  private nextNodeId = 1
  private readonly root = this.createTrieNode()

  constructor(options: TagIndexOptions = {}) {
    this.maxKnownKeys = options.maxKnownKeys
  }

  async touch(key: string): Promise<void> {
    this.insertKnownKey(key)
    this.pruneKnownKeysIfNeeded()
  }

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

  async remove(key: string): Promise<void> {
    this.removeKey(key)
  }

  async keysForTag(tag: string): Promise<string[]> {
    return [...(this.tagToKeys.get(tag) ?? new Set<string>())]
  }

  async keysForPrefix(prefix: string): Promise<string[]> {
    const node = this.findNode(prefix)
    if (!node) {
      return []
    }

    const matches: string[] = []
    this.collectFromNode(node, prefix, matches)
    return matches
  }

  async tagsForKey(key: string): Promise<string[]> {
    return [...(this.keyToTags.get(key) ?? new Set<string>())]
  }

  async matchPattern(pattern: string): Promise<string[]> {
    const matches = new Set<string>()
    this.collectPatternMatches(this.root, '', pattern, 0, matches, new Set<string>())
    return [...matches]
  }

  async clear(): Promise<void> {
    this.tagToKeys.clear()
    this.keyToTags.clear()
    this.knownKeys.clear()
    this.root.children.clear()
    this.root.terminal = false
  }

  private createTrieNode(): TrieNode {
    return {
      id: this.nextNodeId++,
      terminal: false,
      children: new Map<string, TrieNode>()
    }
  }

  private insertKnownKey(key: string): void {
    if (this.knownKeys.has(key)) {
      return
    }

    this.knownKeys.add(key)

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

  private collectPatternMatches(
    node: TrieNode,
    prefix: string,
    pattern: string,
    patternIndex: number,
    matches: Set<string>,
    visited: Set<string>
  ): void {
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
      this.collectPatternMatches(node, prefix, pattern, patternIndex + 1, matches, visited)
      for (const [character, child] of node.children) {
        this.collectPatternMatches(child, `${prefix}${character}`, pattern, patternIndex, matches, visited)
      }
      return
    }

    if (patternChar === '?') {
      for (const [character, child] of node.children) {
        this.collectPatternMatches(child, `${prefix}${character}`, pattern, patternIndex + 1, matches, visited)
      }
      return
    }

    const child = node.children.get(patternChar)
    if (child) {
      this.collectPatternMatches(child, `${prefix}${patternChar}`, pattern, patternIndex + 1, matches, visited)
    }
  }

  private pruneKnownKeysIfNeeded(): void {
    if (this.maxKnownKeys === undefined || this.knownKeys.size <= this.maxKnownKeys) {
      return
    }

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
