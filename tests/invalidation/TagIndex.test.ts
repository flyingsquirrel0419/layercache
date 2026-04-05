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
})
