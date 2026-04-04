import type { CacheLayer } from '../types'
import { unwrapStoredValue } from '../internal/StoredValue'

export interface MemoryLayerSnapshotEntry {
  key: string
  value: unknown
  expiresAt: number | null
}

/**
 * Eviction policy applied when `maxSize` is reached.
 * - `lru` (default): evicts the Least Recently Used entry.
 * - `lfu`: evicts the Least Frequently Used entry.
 * - `fifo`: evicts the oldest inserted entry.
 */
export type EvictionPolicy = 'lru' | 'lfu' | 'fifo'

interface MemoryLayerOptions {
  ttl?: number
  maxSize?: number
  name?: string
  evictionPolicy?: EvictionPolicy
}

interface MemoryEntry {
  value: unknown
  expiresAt: number | null
  /** Insertion order for FIFO, access count for LFU */
  frequency: number
  /** Insertion timestamp, used as tiebreaker */
  insertedAt: number
}

export class MemoryLayer implements CacheLayer {
  readonly name: string
  readonly defaultTtl?: number
  readonly isLocal = true

  private readonly maxSize: number
  private readonly evictionPolicy: EvictionPolicy
  private readonly entries = new Map<string, MemoryEntry>()

  constructor(options: MemoryLayerOptions = {}) {
    this.name = options.name ?? 'memory'
    this.defaultTtl = options.ttl
    this.maxSize = options.maxSize ?? 1_000
    this.evictionPolicy = options.evictionPolicy ?? 'lru'
  }

  async get<T>(key: string): Promise<T | null> {
    const value = await this.getEntry(key)
    return unwrapStoredValue<T>(value)
  }

  async getEntry<T = unknown>(key: string): Promise<T | null> {
    const entry = this.entries.get(key)
    if (!entry) {
      return null
    }

    if (this.isExpired(entry)) {
      this.entries.delete(key)
      return null
    }

    if (this.evictionPolicy === 'lru') {
      // Re-insert to move to "most recently used" position
      this.entries.delete(key)
      entry.frequency += 1
      this.entries.set(key, entry)
    } else {
      // LFU / FIFO: just bump frequency counter
      entry.frequency += 1
    }

    return entry.value as T
  }

  async getMany<T>(keys: string[]): Promise<Array<T | null>> {
    const values: Array<T | null> = []
    for (const key of keys) {
      values.push(await this.getEntry<T>(key))
    }
    return values
  }

  async set(key: string, value: unknown, ttl = this.defaultTtl): Promise<void> {
    this.entries.delete(key)
    this.entries.set(key, {
      value,
      expiresAt: ttl && ttl > 0 ? Date.now() + ttl * 1_000 : null,
      frequency: 0,
      insertedAt: Date.now()
    })

    while (this.entries.size > this.maxSize) {
      this.evict()
    }
  }

  async has(key: string): Promise<boolean> {
    const entry = this.entries.get(key)
    if (!entry) {
      return false
    }
    if (this.isExpired(entry)) {
      this.entries.delete(key)
      return false
    }
    return true
  }

  async ttl(key: string): Promise<number | null> {
    const entry = this.entries.get(key)
    if (!entry) {
      return null
    }
    if (this.isExpired(entry)) {
      this.entries.delete(key)
      return null
    }
    if (entry.expiresAt === null) {
      return null
    }
    return Math.max(0, Math.ceil((entry.expiresAt - Date.now()) / 1_000))
  }

  async size(): Promise<number> {
    this.pruneExpired()
    return this.entries.size
  }

  async delete(key: string): Promise<void> {
    this.entries.delete(key)
  }

  async deleteMany(keys: string[]): Promise<void> {
    for (const key of keys) {
      this.entries.delete(key)
    }
  }

  async clear(): Promise<void> {
    this.entries.clear()
  }

  async keys(): Promise<string[]> {
    this.pruneExpired()
    return [...this.entries.keys()]
  }

  exportState(): MemoryLayerSnapshotEntry[] {
    this.pruneExpired()
    return [...this.entries.entries()].map(([key, entry]) => ({
      key,
      value: entry.value,
      expiresAt: entry.expiresAt
    }))
  }

  importState(entries: MemoryLayerSnapshotEntry[]): void {
    for (const entry of entries) {
      if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
        continue
      }

      this.entries.set(entry.key, {
        value: entry.value,
        expiresAt: entry.expiresAt,
        frequency: 0,
        insertedAt: Date.now()
      })
    }

    while (this.entries.size > this.maxSize) {
      this.evict()
    }
  }

  private evict(): void {
    if (this.evictionPolicy === 'lru' || this.evictionPolicy === 'fifo') {
      // Map insertion order = oldest for both LRU (re-inserts on access) and FIFO
      const oldestKey = this.entries.keys().next().value
      if (oldestKey !== undefined) {
        this.entries.delete(oldestKey)
      }
      return
    }

    // LFU: evict entry with smallest frequency; break ties by insertedAt (oldest)
    let victimKey: string | undefined
    let minFreq = Infinity
    let minInsertedAt = Infinity
    for (const [key, entry] of this.entries.entries()) {
      if (
        entry.frequency < minFreq ||
        (entry.frequency === minFreq && entry.insertedAt < minInsertedAt)
      ) {
        minFreq = entry.frequency
        minInsertedAt = entry.insertedAt
        victimKey = key
      }
    }
    if (victimKey !== undefined) {
      this.entries.delete(victimKey)
    }
  }

  private pruneExpired(): void {
    for (const [key, entry] of this.entries.entries()) {
      if (this.isExpired(entry)) {
        this.entries.delete(key)
      }
    }
  }

  private isExpired(entry: MemoryEntry): boolean {
    return entry.expiresAt !== null && entry.expiresAt <= Date.now()
  }
}
