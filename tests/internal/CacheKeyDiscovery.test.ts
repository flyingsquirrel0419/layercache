import { describe, expect, it, vi } from 'vitest'
import { CacheKeyDiscovery } from '../../src/internal/CacheKeyDiscovery'
import type { CacheLayer, CacheTagIndex } from '../../src/types'

describe('CacheKeyDiscovery', () => {
  it('collects prefix matches from streaming tag indexes and layers', async () => {
    const layerVisitor = vi.fn(async (visitor: (key: string) => Promise<void> | void) => {
      await visitor('user:2')
      await visitor('post:1')
    })
    const discovery = new CacheKeyDiscovery({
      layers: [
        {
          name: 'memory',
          get: vi.fn(),
          set: vi.fn(),
          delete: vi.fn(),
          clear: vi.fn(),
          forEachKey: layerVisitor
        } as unknown as CacheLayer
      ],
      tagIndex: {
        matchPattern: vi.fn(),
        forEachKeyForPrefix: async (_prefix, visitor) => {
          await visitor('user:1')
        }
      } as unknown as CacheTagIndex,
      shouldSkipLayer: () => false,
      handleLayerFailure: vi.fn(async () => undefined)
    })

    await expect(discovery.collectKeysWithPrefix('user:')).resolves.toEqual(['user:1', 'user:2'])
    expect(layerVisitor).toHaveBeenCalledTimes(1)
  })

  it('streams prefix matches without requiring collectKeysWithPrefix callers to materialize results', async () => {
    const seen: string[] = []
    const discovery = new CacheKeyDiscovery({
      layers: [
        {
          name: 'memory',
          get: vi.fn(),
          set: vi.fn(),
          delete: vi.fn(),
          clear: vi.fn(),
          forEachKey: async (visitor) => {
            await visitor('user:2')
            await visitor('post:1')
          }
        } as unknown as CacheLayer
      ],
      tagIndex: {
        matchPattern: vi.fn(),
        forEachKeyForPrefix: async (_prefix, visitor) => {
          await visitor('user:1')
        }
      } as unknown as CacheTagIndex,
      shouldSkipLayer: () => false,
      handleLayerFailure: vi.fn(async () => undefined)
    })

    await discovery.forEachKeyWithPrefix('user:', (key) => {
      seen.push(key)
    })

    expect(seen).toEqual(['user:1', 'user:2'])
  })

  it('deduplicates streamed prefix matches across tag indexes and layers', async () => {
    const seen: string[] = []
    const discovery = new CacheKeyDiscovery({
      layers: [
        {
          name: 'memory',
          get: vi.fn(),
          set: vi.fn(),
          delete: vi.fn(),
          clear: vi.fn(),
          forEachKey: async (visitor) => {
            await visitor('user:1')
            await visitor('user:2')
            await visitor('user:2')
          }
        } as unknown as CacheLayer
      ],
      tagIndex: {
        matchPattern: vi.fn(),
        forEachKeyForPrefix: async (_prefix, visitor) => {
          await visitor('user:1')
        }
      } as unknown as CacheTagIndex,
      shouldSkipLayer: () => false,
      handleLayerFailure: vi.fn(async () => undefined)
    })

    await discovery.forEachKeyWithPrefix('user:', (key) => {
      seen.push(key)
    })

    expect(seen).toEqual(['user:1', 'user:2'])
  })

  it('falls back to array-based scans and handles layer failures', async () => {
    const handleLayerFailure = vi.fn(async () => undefined)
    const discovery = new CacheKeyDiscovery({
      layers: [
        {
          name: 'broken',
          get: vi.fn(),
          set: vi.fn(),
          delete: vi.fn(),
          clear: vi.fn(),
          keys: vi.fn(async () => {
            throw new Error('scan failed')
          })
        } as unknown as CacheLayer,
        {
          name: 'disk',
          get: vi.fn(),
          set: vi.fn(),
          delete: vi.fn(),
          clear: vi.fn(),
          keys: vi.fn(async () => ['user:2', 'post:1'])
        } as unknown as CacheLayer
      ],
      tagIndex: {
        keysForPrefix: vi.fn(async () => ['user:1']),
        matchPattern: vi.fn(async () => [])
      } as unknown as CacheTagIndex,
      shouldSkipLayer: (layer) => layer.name === 'skip-me',
      handleLayerFailure
    })

    await expect(discovery.collectKeysWithPrefix('user:')).resolves.toEqual(['user:1', 'user:2'])
    expect(handleLayerFailure).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'broken' }),
      'invalidate-prefix-scan',
      expect.any(Error)
    )
  })

  it('skips layers without key iteration and reports pattern scan failures', async () => {
    const handleLayerFailure = vi.fn(async () => undefined)
    const discovery = new CacheKeyDiscovery({
      layers: [
        {
          name: 'skip-me',
          get: vi.fn(),
          set: vi.fn(),
          delete: vi.fn(),
          clear: vi.fn(),
          keys: vi.fn(async () => ['user:3'])
        } as unknown as CacheLayer,
        {
          name: 'broken',
          get: vi.fn(),
          set: vi.fn(),
          delete: vi.fn(),
          clear: vi.fn(),
          forEachKey: vi.fn(async () => {
            throw new Error('boom')
          })
        } as unknown as CacheLayer
      ],
      tagIndex: {
        forEachKeyMatchingPattern: async (_pattern, visitor) => {
          await visitor('user:1')
        },
        matchPattern: vi.fn(async () => [])
      } as unknown as CacheTagIndex,
      shouldSkipLayer: (layer) => layer.name === 'skip-me',
      handleLayerFailure
    })

    await expect(discovery.collectKeysMatchingPattern('user:*')).resolves.toEqual(['user:1'])
    expect(handleLayerFailure).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'broken' }),
      'invalidate-pattern-scan',
      expect.any(Error)
    )
  })

  it('collects pattern matches and enforces match limits', async () => {
    const discovery = new CacheKeyDiscovery({
      layers: [
        {
          name: 'memory',
          get: vi.fn(),
          set: vi.fn(),
          delete: vi.fn(),
          clear: vi.fn(),
          forEachKey: async (visitor) => {
            await visitor('user:2')
            await visitor('post:1')
          }
        } as unknown as CacheLayer
      ],
      tagIndex: {
        matchPattern: vi.fn(async () => ['user:1'])
      } as unknown as CacheTagIndex,
      shouldSkipLayer: () => false,
      handleLayerFailure: vi.fn(async () => undefined)
    })

    await expect(discovery.collectKeysMatchingPattern('user:*')).resolves.toEqual(['user:1', 'user:2'])

    const limited = new CacheKeyDiscovery({
      layers: [],
      tagIndex: {
        forEachKeyMatchingPattern: async (_pattern, visitor) => {
          await visitor('user:1')
          await visitor('user:2')
        },
        matchPattern: vi.fn(async () => [])
      } as unknown as CacheTagIndex,
      shouldSkipLayer: () => false,
      handleLayerFailure: vi.fn(async () => undefined)
    })

    await expect(limited.collectKeysMatchingPattern('user:*', 1)).rejects.toThrow(/too many keys/i)
  })

  it('falls back to matchPattern for prefixes and skips non-iterable layers', async () => {
    const discovery = new CacheKeyDiscovery({
      layers: [
        { name: 'opaque', get: vi.fn(), set: vi.fn(), delete: vi.fn(), clear: vi.fn() } as unknown as CacheLayer
      ],
      tagIndex: {
        matchPattern: vi.fn(async () => ['user:1'])
      } as unknown as CacheTagIndex,
      shouldSkipLayer: () => false,
      handleLayerFailure: vi.fn(async () => undefined)
    })

    await expect(discovery.collectKeysWithPrefix('user:')).resolves.toEqual(['user:1'])
  })

  it('uses array-based layer key scans for pattern discovery and enforces prefix limits', async () => {
    const discovery = new CacheKeyDiscovery({
      layers: [
        {
          name: 'disk',
          get: vi.fn(),
          set: vi.fn(),
          delete: vi.fn(),
          clear: vi.fn(),
          keys: vi.fn(async () => ['user:2', 'post:1'])
        } as unknown as CacheLayer
      ],
      tagIndex: {
        matchPattern: vi.fn(async () => ['user:1']),
        keysForPrefix: vi.fn(async () => ['user:1', 'user:2'])
      } as unknown as CacheTagIndex,
      shouldSkipLayer: () => false,
      handleLayerFailure: vi.fn(async () => undefined)
    })

    await expect(discovery.collectKeysMatchingPattern('user:*')).resolves.toEqual(['user:1', 'user:2'])
    await expect(discovery.collectKeysWithPrefix('user:', 1)).rejects.toThrow(/too many keys/i)
  })
})
