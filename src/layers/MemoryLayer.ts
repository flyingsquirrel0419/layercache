import type { CacheLayer } from '../types'
import { unwrapStoredValue } from '../internal/StoredValue'

export interface MemoryLayerSnapshotEntry {
  key: string
  value: unknown
  expiresAt: number | null
}

interface MemoryLayerOptions {
  ttl?: number
  maxSize?: number
  name?: string
}

interface MemoryEntry {
  value: unknown
  expiresAt: number | null
}

export class MemoryLayer implements CacheLayer {
  readonly name: string
  readonly defaultTtl?: number
  readonly isLocal = true

  private readonly maxSize: number
  private readonly entries = new Map<string, MemoryEntry>()

  constructor(options: MemoryLayerOptions = {}) {
    this.name = options.name ?? 'memory'
    this.defaultTtl = options.ttl
    this.maxSize = options.maxSize ?? 1_000
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

    this.entries.delete(key)
    this.entries.set(key, entry)
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
      expiresAt: ttl && ttl > 0 ? Date.now() + ttl * 1_000 : null
    })

    while (this.entries.size > this.maxSize) {
      const oldestKey = this.entries.keys().next().value
      if (!oldestKey) {
        break
      }
      this.entries.delete(oldestKey)
    }
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
        expiresAt: entry.expiresAt
      })
    }

    while (this.entries.size > this.maxSize) {
      const oldestKey = this.entries.keys().next().value
      if (!oldestKey) {
        break
      }
      this.entries.delete(oldestKey)
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
