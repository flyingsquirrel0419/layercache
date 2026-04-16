import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DiskLayer } from '../../src/layers/DiskLayer'
import { MsgpackSerializer } from '../../src/serialization/MsgpackSerializer'

describe('DiskLayer', () => {
  let dir: string
  let layer: DiskLayer

  async function readLcFile(directory: string): Promise<Buffer> {
    const files = await fs.readdir(directory)
    const lcFile = files.find((f) => f.endsWith('.lc'))
    if (!lcFile) throw new Error('No .lc file found in directory')
    return fs.readFile(join(directory, lcFile))
  }

  async function tamperLastByte(directory: string): Promise<void> {
    const files = await fs.readdir(directory)
    const lcFile = files.find((f) => f.endsWith('.lc'))
    if (!lcFile) throw new Error('No .lc file found in directory')
    const filePath = join(directory, lcFile)
    const raw = await fs.readFile(filePath)
    const last = raw.length - 1
    const byte = raw[last] ?? 0
    raw.set([byte ^ 0xff], last)
    await fs.writeFile(filePath, raw)
  }

  beforeEach(async () => {
    dir = join(tmpdir(), `layercache-disk-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    layer = new DiskLayer({ directory: dir, ttl: 60 })
  })

  afterEach(async () => {
    try {
      await fs.rm(dir, { recursive: true, force: true })
    } catch {
      // ignore
    }
  })

  it('should set and get a value', async () => {
    await layer.set('key1', { hello: 'world' })
    const result = await layer.get<{ hello: string }>('key1')
    expect(result).toEqual({ hello: 'world' })
  })

  it('should return null for a missing key', async () => {
    const result = await layer.get('nonexistent')
    expect(result).toBeNull()
  })

  it('should delete a key', async () => {
    await layer.set('key1', 'value1')
    await layer.delete('key1')
    const result = await layer.get('key1')
    expect(result).toBeNull()
  })

  it('should return correct size', async () => {
    await layer.set('a', 1)
    await layer.set('b', 2)
    expect(await layer.size()).toBe(2)
    await layer.delete('a')
    expect(await layer.size()).toBe(1)
  })

  it('should clear all entries', async () => {
    await layer.set('a', 1)
    await layer.set('b', 2)
    await layer.clear()
    expect(await layer.size()).toBe(0)
  })

  it('should return original keys from keys()', async () => {
    await layer.set('user:1', 'alice')
    await layer.set('user:2', 'bob')
    const keys = await layer.keys()
    expect(keys.sort()).toEqual(['user:1', 'user:2'])
  })

  it('should expire entries based on TTL', async () => {
    const shortTtlLayer = new DiskLayer({ directory: dir, ttl: 0.001 })
    await shortTtlLayer.set('expired-key', 'value')
    // Wait for the entry to expire (1 ms TTL)
    await new Promise((resolve) => setTimeout(resolve, 10))
    const result = await shortTtlLayer.get('expired-key')
    expect(result).toBeNull()
  })

  it('should report has() correctly', async () => {
    await layer.set('exists', true)
    expect(await layer.has('exists')).toBe(true)
    expect(await layer.has('nope')).toBe(false)
  })

  it('should report ttl() correctly', async () => {
    await layer.set('with-ttl', 'val', 120)
    const remaining = await layer.ttl('with-ttl')
    expect(remaining).toBeGreaterThan(0)
    expect(remaining).toBeLessThanOrEqual(120)
  })

  it('should return null ttl for missing key', async () => {
    expect(await layer.ttl('missing')).toBeNull()
  })

  it('should deleteMany', async () => {
    await layer.set('a', 1)
    await layer.set('b', 2)
    await layer.set('c', 3)
    await layer.deleteMany(['a', 'c'])
    expect(await layer.has('a')).toBe(false)
    expect(await layer.has('b')).toBe(true)
    expect(await layer.has('c')).toBe(false)
  })

  it('should enforce maxFiles', async () => {
    const boundedLayer = new DiskLayer({ directory: dir, maxFiles: 3 })
    await boundedLayer.set('a', 1)
    await boundedLayer.set('b', 2)
    await boundedLayer.set('c', 3)
    await boundedLayer.set('d', 4) // should evict oldest
    const keys = await boundedLayer.keys()
    expect(keys.length).toBeLessThanOrEqual(3)
  })

  it('should store envelope (getEntry returns raw stored value)', async () => {
    await layer.set('envelope-key', {
      __layercache: 1,
      kind: 'value',
      value: 42,
      freshUntil: null,
      staleUntil: null,
      errorUntil: null
    })
    const entry = await layer.getEntry('envelope-key')
    expect(entry).toHaveProperty('__layercache', 1)
  })

  it('should handle corrupted files gracefully', async () => {
    await fs.mkdir(dir, { recursive: true })
    const { createHash } = await import('node:crypto')
    const hash = createHash('sha256').update('bad-key').digest('hex')
    await fs.writeFile(join(dir, `${hash}.lc`), 'not-json!!!')
    const result = await layer.get('bad-key')
    expect(result).toBeNull()
  })

  it('serializes concurrent writes and leaves no temp files behind', async () => {
    const boundedLayer = new DiskLayer({ directory: dir, maxFiles: 2 })

    await Promise.all([
      boundedLayer.set('a', 1),
      boundedLayer.set('b', 2),
      boundedLayer.set('c', 3),
      boundedLayer.set('d', 4)
    ])

    const entries = await fs.readdir(dir)
    expect(entries.every((entry) => entry.endsWith('.lc'))).toBe(true)
    expect(await boundedLayer.size()).toBeLessThanOrEqual(2)
  })

  it('supports getMany parallel reads', async () => {
    await layer.set('a', 1)
    await layer.set('b', 2)

    await expect(layer.getMany(['a', 'b', 'missing'])).resolves.toEqual([1, 2, null])
  })

  it('rejects invalid directory values early', () => {
    expect(() => new DiskLayer({ directory: '' })).toThrow(/non-empty path/i)
    expect(() => new DiskLayer({ directory: 'bad\u0000path' })).toThrow(/null bytes/i)
  })

  it('treats malformed disk entries as cache misses and removes them', async () => {
    await fs.mkdir(dir, { recursive: true })
    const { createHash } = await import('node:crypto')
    const hash = createHash('sha256').update('weird-key').digest('hex')
    await fs.writeFile(join(dir, `${hash}.lc`), JSON.stringify({ value: 'oops', expiresAt: null }))

    await expect(layer.get('weird-key')).resolves.toBeNull()
    await expect(fs.stat(join(dir, `${hash}.lc`))).rejects.toThrow()
  })

  it('treats oversized disk entries as cache misses and removes them', async () => {
    const boundedLayer = new DiskLayer({ directory: dir, maxEntryBytes: 32 })
    await fs.mkdir(dir, { recursive: true })
    const { createHash } = await import('node:crypto')
    const hash = createHash('sha256').update('huge-key').digest('hex')
    await fs.writeFile(
      join(dir, `${hash}.lc`),
      JSON.stringify({ key: 'huge-key', value: 'x'.repeat(512), expiresAt: null })
    )

    await expect(boundedLayer.get('huge-key')).resolves.toBeNull()
    await expect(fs.stat(join(dir, `${hash}.lc`))).rejects.toThrow()
  })

  it('supports forEachKey, setMany, and dispose', async () => {
    await layer.setMany([
      { key: 'a', value: 1, ttl: 10 },
      { key: 'b', value: 2 }
    ])

    const visited: string[] = []
    await layer.forEachKey(async (key) => {
      visited.push(key)
    })

    expect(visited.sort()).toEqual(['a', 'b'])
    await expect(layer.dispose()).resolves.toBeUndefined()
  })

  it('supports maxEntryBytes=false and removes expired files during scans', async () => {
    const unlimited = new DiskLayer({ directory: dir, maxEntryBytes: false })
    await unlimited.set('huge', 'x'.repeat(2_048))

    await expect(unlimited.get('huge')).resolves.toBe('x'.repeat(2_048))

    const shortTtlLayer = new DiskLayer({ directory: dir, ttl: 0.001 })
    await shortTtlLayer.set('soon-expired', 'value')
    await new Promise((resolve) => setTimeout(resolve, 10))

    await expect(shortTtlLayer.keys()).resolves.not.toContain('soon-expired')
    await expect(shortTtlLayer.size()).resolves.toBeGreaterThanOrEqual(1)
  })

  it('returns false from ping when the directory cannot be created', async () => {
    const mkdirSpy = vi.spyOn(fs, 'mkdir').mockRejectedValueOnce(new Error('nope'))
    await expect(layer.ping()).resolves.toBe(false)
    mkdirSpy.mockRestore()
  })

  it('rejects invalid maxFiles and maxEntryBytes values early', () => {
    expect(() => new DiskLayer({ directory: dir, maxFiles: 0 })).toThrow(/positive integer/i)
    expect(() => new DiskLayer({ directory: dir, maxEntryBytes: 0 })).toThrow(/positive number/i)
  })

  it('skips max-file enforcement when unlimited and tolerates readdir/stat failures', async () => {
    await expect(
      (layer as unknown as { enforceMaxFiles: () => Promise<void> }).enforceMaxFiles()
    ).resolves.toBeUndefined()

    const boundedLayer = new DiskLayer({ directory: dir, maxFiles: 2 })

    const readdirSpy = vi.spyOn(fs, 'readdir').mockRejectedValueOnce(new Error('missing directory'))
    await expect(
      (boundedLayer as unknown as { enforceMaxFiles: () => Promise<void> }).enforceMaxFiles()
    ).resolves.toBeUndefined()
    readdirSpy.mockRestore()

    await boundedLayer.set('a', 1)
    await boundedLayer.set('b', 2)

    const realStat = fs.stat.bind(fs)
    const statSpy = vi.spyOn(fs, 'stat').mockRejectedValueOnce(new Error('stat failed')).mockImplementation(realStat)

    await boundedLayer.set('c', 3)

    expect(statSpy).toHaveBeenCalled()
    expect(await boundedLayer.size()).toBeLessThanOrEqual(2)
    statSpy.mockRestore()
  })

  it('keeps scanning when an entry cannot be opened', async () => {
    await fs.mkdir(dir, { recursive: true })
    const { createHash } = await import('node:crypto')
    const validHash = createHash('sha256').update('scan-good').digest('hex')
    const validFile = join(dir, `${validHash}.lc`)
    await fs.writeFile(validFile, JSON.stringify({ key: 'scan-good', value: 1, expiresAt: null }))

    const realOpen = fs.open.bind(fs)
    const openSpy = vi.spyOn(fs, 'open').mockImplementation(async (path, flags) => {
      if (String(path) === validFile) {
        throw new Error('file vanished')
      }
      return realOpen(path as never, flags as never)
    })

    await expect(layer.keys()).resolves.toEqual([])
    expect(openSpy).toHaveBeenCalled()
    await expect(fs.stat(validFile)).rejects.toThrow()

    openSpy.mockRestore()
  })

  it('deletes corrupted scan entries', async () => {
    await fs.mkdir(dir, { recursive: true })
    const { createHash } = await import('node:crypto')
    const invalidHash = createHash('sha256').update('scan-bad').digest('hex')
    const invalidFile = join(dir, `${invalidHash}.lc`)
    await fs.writeFile(invalidFile, 'not-json!!!')

    await expect(layer.keys()).resolves.toEqual([])
    await expect(fs.stat(invalidFile)).rejects.toThrow()
  })

  it('treats missing directories as empty scans', async () => {
    const missingDir = join(dir, 'missing')
    const missingLayer = new DiskLayer({ directory: missingDir, ttl: 60 })

    const visited: string[] = []
    await expect(missingLayer.keys()).resolves.toEqual([])
    await expect(missingLayer.size()).resolves.toBe(0)
    await expect(
      missingLayer.forEachKey(async (key) => {
        visited.push(key)
      })
    ).resolves.toBeUndefined()
    expect(visited).toEqual([])
  })

  it('treats primitive disk payloads as invalid entries and removes them', async () => {
    await fs.mkdir(dir, { recursive: true })
    const { createHash } = await import('node:crypto')
    const hash = createHash('sha256').update('primitive-bad').digest('hex')
    const filePath = join(dir, `${hash}.lc`)
    await fs.writeFile(filePath, JSON.stringify('oops'))

    await expect(layer.get('primitive-bad')).resolves.toBeNull()
    await expect(fs.stat(filePath)).rejects.toThrow()
  })

  describe('encryption (encryptionKey)', () => {
    it('round-trips values with AES-256-GCM encryption', async () => {
      const encrypted = new DiskLayer({ directory: dir, ttl: 60, encryptionKey: 'test-secret-key' })
      await encrypted.set('secret', { token: 'abc123' })
      const result = await encrypted.get<{ token: string }>('secret')
      expect(result).toEqual({ token: 'abc123' })
    })

    it('round-trips with encryption using MsgpackSerializer (Buffer serializer)', async () => {
      const encrypted = new DiskLayer({
        directory: dir,
        ttl: 60,
        serializer: new MsgpackSerializer(),
        encryptionKey: 'msgpack-secret'
      })
      await encrypted.set('binary-key', { nums: [1, 2, 3], flag: true })
      const result = await encrypted.get<{ nums: number[]; flag: boolean }>('binary-key')
      expect(result).toEqual({ nums: [1, 2, 3], flag: true })
    })

    it('writes encrypted bytes that are not plaintext JSON', async () => {
      const encrypted = new DiskLayer({ directory: dir, ttl: 60, encryptionKey: 'test-key' })
      await encrypted.set('data', { secret: 'value' })
      const raw = await readLcFile(dir)
      const asText = raw.toString('utf8')
      expect(asText).not.toContain('"secret"')
      expect(asText).not.toContain('"value"')
    })

    it('rejects reading tampered encrypted files', async () => {
      const encrypted = new DiskLayer({ directory: dir, ttl: 60, encryptionKey: 'original-key' })
      await encrypted.set('tamper-test', { important: true })
      await tamperLastByte(dir)

      const result = await encrypted.get('tamper-test')
      expect(result).toBeNull()
    })

    it('rejects encrypted data with the wrong key', async () => {
      const writer = new DiskLayer({ directory: dir, ttl: 60, encryptionKey: 'correct-key' })
      await writer.set('locked', { data: 42 })

      const reader = new DiskLayer({ directory: dir, ttl: 60, encryptionKey: 'wrong-key' })
      const result = await reader.get('locked')
      expect(result).toBeNull()
    })
  })

  describe('signing (signingKey)', () => {
    it('round-trips values with HMAC-SHA256 signing', async () => {
      const signed = new DiskLayer({ directory: dir, ttl: 60, signingKey: 'hmac-secret' })
      await signed.set('signed-key', { payload: 'data' })
      const result = await signed.get<{ payload: string }>('signed-key')
      expect(result).toEqual({ payload: 'data' })
    })

    it('round-trips with signing using MsgpackSerializer (Buffer serializer)', async () => {
      const signed = new DiskLayer({
        directory: dir,
        ttl: 60,
        serializer: new MsgpackSerializer(),
        signingKey: 'msgpack-hmac-key'
      })
      await signed.set('signed-binary', [1, 2, 3])
      const result = await signed.get<number[]>('signed-binary')
      expect(result).toEqual([1, 2, 3])
    })

    it('rejects tampered signed files', async () => {
      const signed = new DiskLayer({ directory: dir, ttl: 60, signingKey: 'sign-key' })
      await signed.set('verify-me', { val: 1 })
      await tamperLastByte(dir)

      const result = await signed.get('verify-me')
      expect(result).toBeNull()
    })

    it('ignores signingKey when encryptionKey is also provided', async () => {
      const both = new DiskLayer({ directory: dir, ttl: 60, encryptionKey: 'enc-key', signingKey: 'sig-key' })
      await both.set('both', { x: 1 })
      const result = await both.get<{ x: number }>('both')
      expect(result).toEqual({ x: 1 })

      const raw = await readLcFile(dir)
      expect(raw.subarray(0, 5).toString()).toBe('LCP1:')
    })
  })

  describe('MsgpackSerializer without protection', () => {
    it('round-trips values using binary serializer without encryption or signing', async () => {
      const msgpackLayer = new DiskLayer({
        directory: dir,
        ttl: 60,
        serializer: new MsgpackSerializer()
      })
      await msgpackLayer.set('binary', { arr: [1, 2, 3], nested: { a: true } })
      const result = await msgpackLayer.get<{ arr: number[]; nested: { a: boolean } }>('binary')
      expect(result).toEqual({ arr: [1, 2, 3], nested: { a: true } })
    })
  })
})
