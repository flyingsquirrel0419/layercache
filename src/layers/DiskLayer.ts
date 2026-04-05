import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { unwrapStoredValue } from '../internal/StoredValue'
import { JsonSerializer } from '../serialization/JsonSerializer'
import type { CacheLayer, CacheSerializer } from '../types'

interface DiskLayerOptions {
  directory: string
  ttl?: number
  name?: string
  serializer?: CacheSerializer
  /**
   * Maximum number of cache files to store on disk. When exceeded, the oldest
   * entries (by file mtime) are evicted to keep the directory bounded.
   * Defaults to unlimited.
   */
  maxFiles?: number
}

interface DiskEntry {
  /** Original cache key — stored so that keys() can return real key names. */
  key: string
  value: unknown
  expiresAt: number | null
}

/**
 * A file-system backed cache layer.
 * Each key is stored as a separate JSON file in `directory`.
 * Useful for persisting cache across process restarts without needing Redis.
 *
 * - `keys()` returns the original cache key strings (not hashes).
 * - `maxFiles` limits on-disk entries; when exceeded, oldest files are evicted.
 *
 * NOTE: DiskLayer is designed for low-to-medium traffic scenarios.
 * For high-throughput workloads, use MemoryLayer + RedisLayer.
 */
export class DiskLayer implements CacheLayer {
  readonly name: string
  readonly defaultTtl?: number
  readonly isLocal = true

  private readonly directory: string
  private readonly serializer: CacheSerializer
  private readonly maxFiles: number | undefined

  constructor(options: DiskLayerOptions) {
    this.directory = options.directory
    this.defaultTtl = options.ttl
    this.name = options.name ?? 'disk'
    this.serializer = options.serializer ?? new JsonSerializer()
    this.maxFiles = options.maxFiles
  }

  async get<T>(key: string): Promise<T | null> {
    return unwrapStoredValue<T>(await this.getEntry(key))
  }

  async getEntry<T = unknown>(key: string): Promise<T | null> {
    const filePath = this.keyToPath(key)
    let raw: Buffer
    try {
      raw = await fs.readFile(filePath)
    } catch {
      return null
    }

    let entry: DiskEntry
    try {
      entry = this.serializer.deserialize<DiskEntry>(raw)
    } catch {
      await this.safeDelete(filePath)
      return null
    }

    if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
      await this.safeDelete(filePath)
      return null
    }

    return entry.value as T
  }

  async set(key: string, value: unknown, ttl = this.defaultTtl): Promise<void> {
    await fs.mkdir(this.directory, { recursive: true })
    const entry: DiskEntry = {
      key,
      value,
      expiresAt: ttl && ttl > 0 ? Date.now() + ttl * 1_000 : null
    }
    const payload = this.serializer.serialize(entry)
    await fs.writeFile(this.keyToPath(key), payload)

    if (this.maxFiles !== undefined) {
      await this.enforceMaxFiles()
    }
  }

  async has(key: string): Promise<boolean> {
    const value = await this.getEntry(key)
    return value !== null
  }

  async ttl(key: string): Promise<number | null> {
    const filePath = this.keyToPath(key)
    let raw: Buffer
    try {
      raw = await fs.readFile(filePath)
    } catch {
      return null
    }

    let entry: DiskEntry
    try {
      entry = this.serializer.deserialize<DiskEntry>(raw)
    } catch {
      return null
    }

    if (entry.expiresAt === null) {
      return null
    }

    const remaining = Math.ceil((entry.expiresAt - Date.now()) / 1_000)
    if (remaining <= 0) {
      return null
    }
    return remaining
  }

  async delete(key: string): Promise<void> {
    await this.safeDelete(this.keyToPath(key))
  }

  async deleteMany(keys: string[]): Promise<void> {
    await Promise.all(keys.map((key) => this.delete(key)))
  }

  async clear(): Promise<void> {
    let entries: string[]
    try {
      entries = await fs.readdir(this.directory)
    } catch {
      return
    }

    await Promise.all(
      entries.filter((name) => name.endsWith('.lc')).map((name) => this.safeDelete(join(this.directory, name)))
    )
  }

  /**
   * Returns the original cache key strings stored on disk.
   * Expired entries are skipped and cleaned up during the scan.
   */
  async keys(): Promise<string[]> {
    let entries: string[]
    try {
      entries = await fs.readdir(this.directory)
    } catch {
      return []
    }

    const lcFiles = entries.filter((name) => name.endsWith('.lc'))
    const keys: string[] = []

    await Promise.all(
      lcFiles.map(async (name) => {
        const filePath = join(this.directory, name)
        let raw: Buffer
        try {
          raw = await fs.readFile(filePath)
        } catch {
          return
        }

        let entry: DiskEntry
        try {
          entry = this.serializer.deserialize<DiskEntry>(raw)
        } catch {
          await this.safeDelete(filePath)
          return
        }

        if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
          await this.safeDelete(filePath)
          return
        }

        keys.push(entry.key)
      })
    )

    return keys
  }

  async size(): Promise<number> {
    const keys = await this.keys()
    return keys.length
  }

  private keyToPath(key: string): string {
    // Hash the key to produce a safe filename
    const hash = createHash('sha256').update(key).digest('hex')
    return join(this.directory, `${hash}.lc`)
  }

  private async safeDelete(filePath: string): Promise<void> {
    try {
      await fs.unlink(filePath)
    } catch {
      // File already gone — not an error
    }
  }

  /**
   * Removes the oldest files (by mtime) when the directory exceeds maxFiles.
   */
  private async enforceMaxFiles(): Promise<void> {
    if (this.maxFiles === undefined) {
      return
    }

    let entries: string[]
    try {
      entries = await fs.readdir(this.directory)
    } catch {
      return
    }

    const lcFiles = entries.filter((name) => name.endsWith('.lc'))
    if (lcFiles.length <= this.maxFiles) {
      return
    }

    // Collect mtime for each file and sort oldest-first
    const withStats = await Promise.all(
      lcFiles.map(async (name) => {
        const filePath = join(this.directory, name)
        try {
          const stat = await fs.stat(filePath)
          return { filePath, mtimeMs: stat.mtimeMs }
        } catch {
          return { filePath, mtimeMs: 0 }
        }
      })
    )

    withStats.sort((a, b) => a.mtimeMs - b.mtimeMs)
    const toEvict = withStats.slice(0, lcFiles.length - this.maxFiles)
    await Promise.all(toEvict.map(({ filePath }) => this.safeDelete(filePath)))
  }
}
