import { unwrapStoredValue } from '../internal/StoredValue'
import type { CacheLayer, CacheLayerSetManyEntry } from '../types'

export interface MemoryLayerSnapshotEntry {
  /** Cache key stored in the snapshot. */
  key: string
  /** Stored raw value or envelope. */
  value: unknown
  /** Absolute expiry timestamp in milliseconds, or null for no expiry. */
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
  /** Default TTL in milliseconds for entries written without an explicit TTL. */
  ttl?: number
  /** Maximum number of entries retained in memory. Defaults to 1,000. */
  maxSize?: number
  /** Layer name used for metrics and per-layer TTL maps. Defaults to `memory`. */
  name?: string
  /** Eviction policy used when `maxSize` is exceeded. Defaults to `lru`. */
  evictionPolicy?: EvictionPolicy
  /** Milliseconds between automatic expired-entry cleanup passes. Disabled when omitted. */
  cleanupIntervalMs?: number
  /** Called with the key and unwrapped value whenever an entry is evicted. */
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

/**
 * In-process cache layer with TTL support and bounded-size eviction.
 */
export class MemoryLayer implements CacheLayer {
  readonly name: string
  readonly defaultTtl?: number
  readonly isLocal = true

  private readonly maxSize: number
  private readonly evictionPolicy: EvictionPolicy
  private readonly onEvict?: (key: string, value: unknown) => void
  private readonly entries = new Map<string, MemoryEntry>()
  private cleanupTimer?: ReturnType<typeof setInterval>

  /**
   * Creates an in-memory cache layer.
   */
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

  /**
   * Reads and unwraps a fresh value from memory.
   */
  async get<T>(key: string): Promise<T | null> {
    const value = await this.getEntry(key)
    return unwrapStoredValue<T>(value)
  }

  /**
   * Reads the raw stored value or envelope from memory.
   */
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

  /**
   * Reads many raw entries from memory.
   */
  async getMany<T>(keys: string[]): Promise<Array<T | null>> {
    return Promise.all(keys.map((key) => this.getEntry<T>(key)))
  }

  /**
   * Writes many entries to memory.
   */
  async setMany(entries: CacheLayerSetManyEntry[]): Promise<void> {
    await Promise.all(entries.map((entry) => this.set(entry.key, entry.value, entry.ttl)))
  }

  /**
   * Stores a value in memory using the provided TTL or layer default TTL.
   */
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

  /**
   * Returns true when the key exists and has not expired.
   */
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

  /**
   * Returns remaining TTL in milliseconds, or null when absent or non-expiring.
   */
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

  /**
   * Returns the number of currently retained, non-expired entries.
   */
  async size(): Promise<number> {
    this.pruneExpired()
    return this.entries.size
  }

  /**
   * Deletes a key from memory.
   */
  async delete(key: string): Promise<void> {
    this.entries.delete(key)
  }

  /**
   * Deletes multiple keys from memory.
   */
  async deleteMany(keys: string[]): Promise<void> {
    for (const key of keys) {
      this.entries.delete(key)
    }
  }

  /**
   * Removes all entries from memory.
   */
  async clear(): Promise<void> {
    this.entries.clear()
  }

  /**
   * Health check hook that always succeeds for the in-process layer.
   */
  async ping(): Promise<boolean> {
    return true
  }

  /**
   * Stops the cleanup timer, when one is active.
   */
  async dispose(): Promise<void> {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer)
      this.cleanupTimer = undefined
    }
  }

  /**
   * Returns all currently retained, non-expired keys.
   */
  async keys(): Promise<string[]> {
    this.pruneExpired()
    return [...this.entries.keys()]
  }

  /**
   * Visits all currently retained, non-expired keys.
   */
  async forEachKey(visitor: (key: string) => void | Promise<void>): Promise<void> {
    this.pruneExpired()
    for (const key of this.entries.keys()) {
      await visitor(key)
    }
  }

  /**
   * Exports memory entries for process-local snapshots.
   */
  exportState(): MemoryLayerSnapshotEntry[] {
    this.pruneExpired()
    return [...this.entries.entries()].map(([key, entry]) => ({
      key,
      value: entry.value,
      expiresAt: entry.expiresAt
    }))
  }

  /**
   * Imports entries previously produced by `exportState()`.
   */
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
