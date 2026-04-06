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
})
