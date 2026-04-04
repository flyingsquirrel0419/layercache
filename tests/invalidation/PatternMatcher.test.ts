import { describe, expect, it } from 'vitest'
import { PatternMatcher } from '../../src/invalidation/PatternMatcher'

describe('PatternMatcher', () => {
  it('matches exact strings', () => {
    expect(PatternMatcher.matches('foo', 'foo')).toBe(true)
    expect(PatternMatcher.matches('foo', 'bar')).toBe(false)
  })

  it('matches * as any sequence', () => {
    expect(PatternMatcher.matches('user:*', 'user:123')).toBe(true)
    expect(PatternMatcher.matches('user:*', 'user:')).toBe(true)
    expect(PatternMatcher.matches('user:*', 'order:123')).toBe(false)
  })

  it('matches ? as any single character', () => {
    expect(PatternMatcher.matches('user:?', 'user:1')).toBe(true)
    expect(PatternMatcher.matches('user:?', 'user:12')).toBe(false)
    expect(PatternMatcher.matches('user:?', 'user:')).toBe(false)
  })

  it('handles multiple wildcards', () => {
    expect(PatternMatcher.matches('*:*', 'user:123')).toBe(true)
    expect(PatternMatcher.matches('*:*', 'abc')).toBe(false)
  })

  it('matches bare * against anything', () => {
    expect(PatternMatcher.matches('*', '')).toBe(true)
    expect(PatternMatcher.matches('*', 'anything')).toBe(true)
  })

  it('does not match partial prefix without wildcard', () => {
    expect(PatternMatcher.matches('user', 'user:123')).toBe(false)
  })

  it('is safe against pathological inputs (no ReDoS)', () => {
    // Previously this could hang with regex-based implementation
    const pattern = '*'.repeat(50)
    const value = 'a'.repeat(50)
    expect(() => PatternMatcher.matches(pattern, value)).not.toThrow()
    expect(PatternMatcher.matches(pattern, value)).toBe(true)
  })

  it('escapes regex special characters in literal parts', () => {
    expect(PatternMatcher.matches('user.(123)', 'user.(123)')).toBe(true)
    expect(PatternMatcher.matches('user.(123)', 'user1123')).toBe(false)
  })
})
