import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DiskLayer } from '../../src/layers/DiskLayer'

describe('DiskLayer', () => {
  let dir: string
  let layer: DiskLayer

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
})
