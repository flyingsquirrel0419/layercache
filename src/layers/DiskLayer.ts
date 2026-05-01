import { createHash, randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join, resolve } from 'node:path'
import { PayloadProtection, type PayloadProtectionOptions } from '../internal/PayloadProtection'
import { unwrapStoredValue } from '../internal/StoredValue'
import { JsonSerializer } from '../serialization/JsonSerializer'
import type { CacheLayer, CacheLayerSetManyEntry, CacheSerializer } from '../types'

interface DiskLayerOptions {
  directory: string
  ttl?: number
  name?: string
  serializer?: CacheSerializer
  /**
   * Maximum number of cache files to store on disk. When exceeded, the oldest
   * entries (by file mtime) are evicted to keep the directory bounded.
   * Defaults to 50 000. Set to `Infinity` to disable the limit (not recommended
   * in production — unbounded growth will eventually exhaust disk space).
   */
  maxFiles?: number
  /**
   * Maximum size, in bytes, of a single cache file that this layer will read.
   * Oversized entries are treated as corrupted and removed. Defaults to 16 MiB.
   * Set to `false` to disable the limit.
   */
  maxEntryBytes?: number | false
  /**
   * Encrypt cached data at rest using AES-256-GCM. Accepts a string or Buffer.
   * The key material is hashed with SHA-256 to derive the actual cipher key.
   * Encryption also provides authenticated integrity — a separate signingKey
   * is unnecessary when encryption is enabled.
   */
  encryptionKey?: string | Buffer
  /**
   * Sign cached data at rest using HMAC-SHA256 for integrity verification.
   * Accepts a string or Buffer. Ignored when `encryptionKey` is also provided
   * (AES-GCM already provides integrity).
   */
  signingKey?: string | Buffer
}

interface DiskEntry {
  /** Original cache key — stored so that keys() can return real key names. */
  key: string
  value: unknown
  expiresAt: number | null
}

const FILE_SCAN_CONCURRENCY = 32

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
  private readonly maxEntryBytes: number | false
  private readonly protection: PayloadProtection
  private writeQueue = Promise.resolve()

  constructor(options: DiskLayerOptions) {
    this.directory = this.resolveDirectory(options.directory)
    this.defaultTtl = options.ttl
    this.name = options.name ?? 'disk'
    this.serializer = options.serializer ?? new JsonSerializer()
    this.maxFiles = this.normalizeMaxFiles(options.maxFiles)
    this.maxEntryBytes = this.normalizeMaxEntryBytes(options.maxEntryBytes)
    this.protection = new PayloadProtection({
      encryptionKey: options.encryptionKey,
      signingKey: options.signingKey
    })
  }

  async get<T>(key: string): Promise<T | null> {
    return unwrapStoredValue<T>(await this.getEntry(key))
  }

  async getEntry<T = unknown>(key: string): Promise<T | null> {
    const filePath = this.keyToPath(key)
    const raw = await this.readEntryFile(filePath)
    if (raw === null) {
      return null
    }

    let entry: DiskEntry
    try {
      entry = this.deserializeEntry(raw)
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
    await this.enqueueWrite(async () => {
      await fs.mkdir(this.directory, { recursive: true })
      const entry: DiskEntry = {
        key,
        value,
        expiresAt: ttl && ttl > 0 ? Date.now() + ttl : null
      }
      const payload = this.serializer.serialize(entry)
      const raw = Buffer.isBuffer(payload) ? payload : Buffer.from(payload as string, 'utf8')
      const protectedPayload = this.protection.protect(raw)
      const targetPath = this.keyToPath(key)
      const tempPath = `${targetPath}.${process.pid}.${Date.now()}.${randomBytes(8).toString('hex')}.tmp`
      try {
        await fs.writeFile(tempPath, protectedPayload)
        await fs.rename(tempPath, targetPath)
      } catch (error) {
        await this.safeDelete(tempPath)
        throw error
      }

      if (this.maxFiles !== undefined) {
        await this.enforceMaxFiles()
      }
    })
  }

  async getMany<T>(keys: string[]): Promise<Array<T | null>> {
    return Promise.all(keys.map((key) => this.getEntry<T>(key)))
  }

  async setMany(entries: CacheLayerSetManyEntry[]): Promise<void> {
    await Promise.all(entries.map((entry) => this.set(entry.key, entry.value, entry.ttl)))
  }

  async has(key: string): Promise<boolean> {
    const value = await this.getEntry(key)
    return value !== null
  }

  async ttl(key: string): Promise<number | null> {
    const filePath = this.keyToPath(key)
    const raw = await this.readEntryFile(filePath)
    if (raw === null) {
      return null
    }

    let entry: DiskEntry
    try {
      entry = this.deserializeEntry(raw)
    } catch {
      await this.safeDelete(filePath)
      return null
    }

    if (entry.expiresAt === null) {
      return null
    }

    const remaining = Math.ceil(entry.expiresAt - Date.now())
    if (remaining <= 0) {
      return null
    }
    return remaining
  }

  async delete(key: string): Promise<void> {
    await this.enqueueWrite(() => this.safeDelete(this.keyToPath(key)))
  }

  async deleteMany(keys: string[]): Promise<void> {
    await this.enqueueWrite(async () => {
      await this.deletePathsWithConcurrency(keys.map((key) => this.keyToPath(key)))
    })
  }

  async clear(): Promise<void> {
    await this.enqueueWrite(async () => {
      let entries: string[]
      try {
        entries = await fs.readdir(this.directory)
      } catch {
        return
      }

      await this.deletePathsWithConcurrency(
        entries.filter((name) => name.endsWith('.lc')).map((name) => join(this.directory, name))
      )
    })
  }

  /**
   * Returns the original cache key strings stored on disk.
   * Expired entries are skipped and cleaned up during the scan.
   */
  async keys(): Promise<string[]> {
    const keys: string[] = []
    await this.scanEntries(async (entry) => {
      keys.push(entry.key)
    })
    return keys
  }

  async forEachKey(visitor: (key: string) => void | Promise<void>): Promise<void> {
    await this.scanEntries(async (entry) => {
      await visitor(entry.key)
    })
  }

  async size(): Promise<number> {
    let count = 0
    await this.scanEntries(async () => {
      count += 1
    })
    return count
  }

  async ping(): Promise<boolean> {
    try {
      await fs.mkdir(this.directory, { recursive: true })
      return true
    } catch {
      return false
    }
  }

  async dispose(): Promise<void> {}

  private keyToPath(key: string): string {
    // Hash the key to produce a safe filename
    const hash = createHash('sha256').update(key).digest('hex')
    return join(this.directory, `${hash}.lc`)
  }

  private resolveDirectory(directory: string): string {
    if (typeof directory !== 'string' || directory.trim().length === 0) {
      throw new Error('DiskLayer.directory must be a non-empty path.')
    }

    if (directory.includes('\u0000')) {
      throw new Error('DiskLayer.directory must not contain null bytes.')
    }

    return resolve(directory)
  }

  private normalizeMaxFiles(maxFiles: number | undefined): number | undefined {
    if (maxFiles === undefined) {
      return 50_000
    }

    if (maxFiles === Number.POSITIVE_INFINITY) {
      return undefined
    }

    if (!Number.isInteger(maxFiles) || maxFiles <= 0) {
      throw new Error('DiskLayer.maxFiles must be a positive integer or Infinity.')
    }

    return maxFiles
  }

  private normalizeMaxEntryBytes(maxEntryBytes: number | false | undefined): number | false {
    if (maxEntryBytes === false) {
      return false
    }

    const normalized = maxEntryBytes ?? 16 * 1_024 * 1_024
    if (!Number.isFinite(normalized) || normalized <= 0) {
      throw new Error('DiskLayer.maxEntryBytes must be a positive number or false.')
    }

    return normalized
  }

  private async readEntryFile(filePath: string): Promise<Buffer | null> {
    let handle: fs.FileHandle | undefined
    try {
      handle = await fs.open(filePath, 'r')
      return await this.readHandleWithLimit(handle)
    } catch {
      await this.safeDelete(filePath)
      return null
    } finally {
      await handle?.close().catch(() => undefined)
    }
  }

  private async readHandleWithLimit(handle: fs.FileHandle): Promise<Buffer> {
    if (this.maxEntryBytes === false) {
      return handle.readFile()
    }

    const stat = await handle.stat()
    if (stat.size > this.maxEntryBytes) {
      throw new Error(`DiskLayer entry exceeds maxEntryBytes limit (${stat.size} bytes > ${this.maxEntryBytes} bytes).`)
    }

    const chunks: Buffer[] = []
    let totalBytes = 0
    let position = 0

    while (true) {
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1_024, this.maxEntryBytes - totalBytes + 1))
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, position)
      if (bytesRead === 0) {
        break
      }

      totalBytes += bytesRead
      if (totalBytes > this.maxEntryBytes) {
        throw new Error(
          `DiskLayer entry exceeds maxEntryBytes limit (${totalBytes} bytes > ${this.maxEntryBytes} bytes).`
        )
      }

      chunks.push(buffer.subarray(0, bytesRead))
      position += bytesRead
    }

    return Buffer.concat(chunks)
  }

  private async scanEntries(visitor: (entry: DiskEntry) => Promise<void> | void): Promise<void> {
    let entries: string[]
    try {
      entries = await fs.readdir(this.directory)
    } catch {
      return
    }

    const lcFiles = entries.filter((name) => name.endsWith('.lc'))
    let nextIndex = 0
    const workerCount = Math.min(FILE_SCAN_CONCURRENCY, lcFiles.length)

    await Promise.all(
      Array.from({ length: workerCount }, async () => {
        while (true) {
          const currentIndex = nextIndex
          nextIndex += 1
          const name = lcFiles[currentIndex]
          if (name === undefined) {
            return
          }

          const filePath = join(this.directory, name)
          const raw = await this.readEntryFile(filePath)
          if (raw === null) {
            continue
          }

          let entry: DiskEntry
          try {
            entry = this.deserializeEntry(raw)
          } catch {
            await this.safeDelete(filePath)
            continue
          }

          if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
            await this.safeDelete(filePath)
            continue
          }

          await visitor(entry)
        }
      })
    )
  }

  private async deletePathsWithConcurrency(paths: string[]): Promise<void> {
    let nextIndex = 0
    const workerCount = Math.min(FILE_SCAN_CONCURRENCY, paths.length)

    await Promise.all(
      Array.from({ length: workerCount }, async () => {
        while (true) {
          const currentIndex = nextIndex
          nextIndex += 1
          const filePath = paths[currentIndex]
          if (filePath === undefined) {
            return
          }

          await this.safeDelete(filePath)
        }
      })
    )
  }

  private deserializeEntry(raw: Buffer): DiskEntry {
    const unprotected = this.protection.unprotect(raw)
    const entry = this.serializer.deserialize<unknown>(unprotected)
    if (!isDiskEntry(entry)) {
      throw new Error('Invalid disk cache entry.')
    }

    return entry
  }

  private async safeDelete(filePath: string): Promise<void> {
    try {
      await fs.unlink(filePath)
    } catch {
      // File already gone — not an error
    }
  }

  private enqueueWrite(operation: () => Promise<void>): Promise<void> {
    const next = this.writeQueue.then(operation, operation)
    /* v8 ignore next -- queue poison pill is intentionally swallowed for later writes */
    this.writeQueue = next.catch(() => undefined)
    return next
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

function isDiskEntry(value: unknown): value is DiskEntry {
  if (!value || typeof value !== 'object') {
    return false
  }

  const candidate = value as Partial<DiskEntry>
  const validExpiry = candidate.expiresAt === null || typeof candidate.expiresAt === 'number'

  return typeof candidate.key === 'string' && validExpiry && 'value' in candidate
}
