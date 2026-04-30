import { unwrapStoredValue } from '../internal/StoredValue'
import type { CacheLayer, CacheLayerSetManyEntry } from '../types'

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

export interface MemoryLayerOptions {
  ttl?: number
  maxSize?: number
  name?: string
  evictionPolicy?: EvictionPolicy
  cleanupIntervalMs?: number
  onEvict?: (key: string, value: unknown) => void
}

interface MemoryEntry {
  value: unknown
  expiresAt: number | null
  /** Access count — used by LFU to find the least-frequently-used entry. */
  accessCount: number
  /** Insertion timestamp in ms — used as a tiebreaker for LFU eviction. */
  insertedAt: number
}

export class MemoryLayer implements CacheLayer {
  readonly name: string
  readonly defaultTtl?: number
  readonly isLocal = true

  private readonly maxSize: number
  private readonly evictionPolicy: EvictionPolicy
  private readonly onEvict?: (key: string, value: unknown) => void
  private readonly entries = new Map<string, MemoryEntry>()
  private cleanupTimer?: ReturnType<typeof setInterval>

  constructor(options: MemoryLayerOptions = {}) {
    this.name = options.name ?? 'memory'
    this.defaultTtl = options.ttl
    this.maxSize = options.maxSize ?? 1_000
    this.evictionPolicy = options.evictionPolicy ?? 'lru'
    this.onEvict = options.onEvict

    if (options.cleanupIntervalMs && options.cleanupIntervalMs > 0) {
      this.cleanupTimer = setInterval(() => {
        this.pruneExpired()
      }, options.cleanupIntervalMs)
      this.cleanupTimer.unref?.()
    }
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
      // Re-insert to move to "most recently used" position in Map iteration order
      this.entries.delete(key)
      entry.accessCount += 1
      this.entries.set(key, entry)
    } else if (this.evictionPolicy === 'lfu') {
      // Increment access count so the least-frequently-used entry can be found
      entry.accessCount += 1
    }
    // FIFO: access does not affect eviction order — no update needed

    return entry.value as T
  }

  async getMany<T>(keys: string[]): Promise<Array<T | null>> {
    return Promise.all(keys.map((key) => this.getEntry<T>(key)))
  }

  async setMany(entries: CacheLayerSetManyEntry[]): Promise<void> {
    await Promise.all(entries.map((entry) => this.set(entry.key, entry.value, entry.ttl)))
  }

  async set(key: string, value: unknown, ttl = this.defaultTtl): Promise<void> {
    this.entries.delete(key)
    this.entries.set(key, {
      value,
      expiresAt: ttl && ttl > 0 ? Date.now() + ttl : null,
      accessCount: 0,
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
    return Math.max(0, Math.ceil(entry.expiresAt - Date.now()))
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

  async ping(): Promise<boolean> {
    return true
  }

  async dispose(): Promise<void> {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer)
      this.cleanupTimer = undefined
    }
  }

  async keys(): Promise<string[]> {
    this.pruneExpired()
    return [...this.entries.keys()]
  }

  async forEachKey(visitor: (key: string) => void | Promise<void>): Promise<void> {
    this.pruneExpired()
    for (const key of this.entries.keys()) {
      await visitor(key)
    }
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
        accessCount: 0,
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
        const entry = this.entries.get(oldestKey)
        this.entries.delete(oldestKey)
        if (entry) {
          this.onEvict?.(oldestKey, unwrapStoredValue(entry.value))
        }
      }
      return
    }

    // LFU: evict entry with smallest accessCount; break ties by insertedAt (oldest)
    let victimKey: string | undefined
    let minCount = Number.POSITIVE_INFINITY
    let minInsertedAt = Number.POSITIVE_INFINITY
    for (const [key, entry] of this.entries.entries()) {
      if (entry.accessCount < minCount || (entry.accessCount === minCount && entry.insertedAt < minInsertedAt)) {
        minCount = entry.accessCount
        minInsertedAt = entry.insertedAt
        victimKey = key
      }
    }
    if (victimKey !== undefined) {
      const victim = this.entries.get(victimKey)
      this.entries.delete(victimKey)
      if (victim) {
        this.onEvict?.(victimKey, unwrapStoredValue(victim.value))
      }
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
