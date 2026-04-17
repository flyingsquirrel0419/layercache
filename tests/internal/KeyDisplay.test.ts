import { describe, expect, it } from 'vitest'
import { KEY_DISPLAY_LENGTH, displayKey } from '../../src/internal/KeyDisplay'

describe('KeyDisplay', () => {
  it('returns the key unchanged when shorter than the limit', () => {
    expect(displayKey('short-key')).toBe('short-key')
  })

  it('returns the key unchanged when exactly at the limit', () => {
    const key = 'x'.repeat(KEY_DISPLAY_LENGTH)
    expect(displayKey(key)).toBe(key)
  })

  it('truncates and appends ellipsis when longer than the limit', () => {
    const key = 'x'.repeat(200)
    const result = displayKey(key)
    expect(result).toBe(`${'x'.repeat(KEY_DISPLAY_LENGTH)}...`)
    expect(result.length).toBe(KEY_DISPLAY_LENGTH + 3)
  })

  it('handles an empty string', () => {
    expect(displayKey('')).toBe('')
  })

  it('handles a key one character over the limit', () => {
    const key = 'x'.repeat(KEY_DISPLAY_LENGTH + 1)
    expect(displayKey(key)).toBe(`${'x'.repeat(KEY_DISPLAY_LENGTH)}...`)
  })
})
