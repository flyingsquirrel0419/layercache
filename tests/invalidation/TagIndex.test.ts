import { describe, expect, it, vi } from 'vitest'
import { TagIndex } from '../../src/invalidation/TagIndex'

describe('TagIndex', () => {
  it('keeps tag mappings when known keys are trimmed', async () => {
    const index = new TagIndex({ maxKnownKeys: 2 })

    await index.track('user:1', ['users'])
    await index.track('user:2', ['users'])
    await index.track('user:3', ['users'])

    expect(await index.keysForTag('users')).toEqual(['user:1', 'user:2', 'user:3'])
    expect(await index.keysForPrefix('user:')).toEqual(['user:2', 'user:3'])
  })

  it('returns prefix matches without scanning unrelated keys', async () => {
    const index = new TagIndex()

    await index.touch('user:1:profile')
    await index.touch('user:1:posts')
    await index.touch('user:2:profile')

    expect(await index.keysForPrefix('user:1:')).toEqual(['user:1:profile', 'user:1:posts'])
  })

  it('prunes known keys without sorting the full index', async () => {
    const index = new TagIndex({ maxKnownKeys: 2 })
    const sort = vi.spyOn(Array.prototype, 'sort')

    await index.touch('user:1')
    await index.touch('user:2')
    await index.touch('user:3')

    expect(sort).not.toHaveBeenCalled()
    sort.mockRestore()
  })

  it('matches wildcard patterns through the trie-backed known-key index', async () => {
    const index = new TagIndex()

    await index.touch('user:1')
    await index.touch('user:2')
    await index.touch('post:1')

    expect((await index.matchPattern('user:*')).sort()).toEqual(['user:1', 'user:2'])
  })

  it('matches long structured keys without recursive wildcard traversal limits', async () => {
    const index = new TagIndex()
    const longSegment = 'a'.repeat(600)
    const key = `user:${longSegment}:profile`

    await index.touch(key)
    await index.touch(`post:${longSegment}:profile`)

    expect(await index.matchPattern(`user:${longSegment}:*`)).toEqual([key])
  })

  it('resets public key indexes when cleared', async () => {
    const index = new TagIndex()

    await index.touch('user:1')
    await index.track('user:2', ['users'])
    await index.clear()

    await expect(index.keysForPrefix('user:')).resolves.toEqual([])
    await expect(index.matchPattern('user:*')).resolves.toEqual([])
    await expect(index.tagsForKey('user:2')).resolves.toEqual([])

    await index.touch('post:1')
    await index.track('post:2', ['posts'])

    expect(await index.keysForPrefix('post:')).toEqual(['post:1', 'post:2'])
    expect(await index.keysForTag('posts')).toEqual(['post:2'])
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

  it('retracks keys through the public API and keeps prefix cleanup consistent', async () => {
    const index = new TagIndex()

    await index.track('user:1', ['users'])
    await index.track('user:1', ['admins'])
    await index.track('user:1:profile', ['profiles'])
    await index.track('user:1:posts', ['profiles'])

    await expect(index.keysForTag('users')).resolves.toEqual([])
    await expect(index.keysForTag('admins')).resolves.toEqual(['user:1'])

    await index.remove('user:1:profile')

    await expect(index.keysForPrefix('user:1:')).resolves.toEqual(['user:1:posts'])
    await expect(index.tagsForKey('user:1:profile')).resolves.toEqual([])
  })

  it('ignores removals for unknown keys', async () => {
    const index = new TagIndex()

    await index.remove('missing')
    await expect(index.keysForPrefix('missing:')).resolves.toEqual([])
  })
})
