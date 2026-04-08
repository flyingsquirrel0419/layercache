import { describe, expect, it } from 'vitest'
import * as edge from '../src/edge.ts'
import { CacheMissError } from '../src/types'

describe('edge entrypoint exports', () => {
  it('re-exports edge-safe modules', async () => {
    expect(edge.createHonoCacheMiddleware).toBeTypeOf('function')
    const layer = new edge.MemoryLayer({ ttl: 60 })
    await layer.set('user:1', { id: 1 })

    expect(await layer.get('user:1')).toEqual({ id: 1 })
    expect(edge.PatternMatcher.matches('user:*', 'user:1')).toBe(true)

    const tags = new edge.TagIndex()
    await tags.track('user:1', ['team:a'])
    await expect(tags.keysForTag('team:a')).resolves.toEqual(['user:1'])
  })

  it('exposes CacheMissError metadata', () => {
    const error = new CacheMissError('missing:key')
    expect(error.name).toBe('CacheMissError')
    expect(error.key).toBe('missing:key')
    expect(error.message).toContain('missing:key')
  })
})
