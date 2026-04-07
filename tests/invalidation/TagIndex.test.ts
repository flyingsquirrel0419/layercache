import { describe, expect, it } from 'vitest'
import { TagIndex } from '../../src/invalidation/TagIndex'

describe('TagIndex', () => {
  it('prunes tag reverse references when known keys are trimmed', async () => {
    const index = new TagIndex({ maxKnownKeys: 2 })

    await index.track('user:1', ['users'])
    await index.track('user:2', ['users'])
    await index.track('user:3', ['users'])

    expect(await index.keysForTag('users')).toEqual(['user:2', 'user:3'])
  })

  it('returns prefix matches without scanning unrelated keys', async () => {
    const index = new TagIndex()

    await index.touch('user:1:profile')
    await index.touch('user:1:posts')
    await index.touch('user:2:profile')

    expect(await index.keysForPrefix('user:1:')).toEqual(['user:1:profile', 'user:1:posts'])
  })

  it('matches wildcard patterns through the trie-backed known-key index', async () => {
    const index = new TagIndex()

    await index.touch('user:1')
    await index.touch('user:2')
    await index.touch('post:1')

    expect((await index.matchPattern('user:*')).sort()).toEqual(['user:1', 'user:2'])
  })

  it('resets trie node ids when cleared', async () => {
    const index = new TagIndex()

    await index.touch('user:1')
    await index.clear()
    await index.touch('post:1')

    expect(await index.keysForPrefix('post:')).toEqual(['post:1'])
    expect((index as unknown as { nextNodeId: number }).nextNodeId).toBeGreaterThan(1)
    expect((index as unknown as { nextNodeId: number }).nextNodeId).toBeLessThan(10)
  })

  it('supports tagsForKey, visitor helpers, and key removal', async () => {
    const index = new TagIndex()

    await index.track('user:1', ['users', 'admins'])
    await index.track('user:2', [])

    await expect(index.tagsForKey('user:1')).resolves.toEqual(['users', 'admins'])
    await expect(index.tagsForKey('user:2')).resolves.toEqual([])

    const byTag: string[] = []
    await index.forEachKeyForTag('users', async (key) => {
      byTag.push(key)
    })
    expect(byTag).toEqual(['user:1'])

    const byPrefix: string[] = []
    await index.forEachKeyForPrefix('user:', async (key) => {
      byPrefix.push(key)
    })
    expect(byPrefix.sort()).toEqual(['user:1', 'user:2'])

    const byPattern: string[] = []
    await index.forEachKeyMatchingPattern('user:?', async (key) => {
      byPattern.push(key)
    })
    expect(byPattern.sort()).toEqual(['user:1', 'user:2'])

    await index.remove('user:1')
    await expect(index.keysForTag('users')).resolves.toEqual([])
  })
})
