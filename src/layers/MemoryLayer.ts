import type { CacheLayer } from '../types'

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
