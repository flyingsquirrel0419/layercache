import { describe, expect, it } from 'vitest'
import {
  generationPrefix,
  planGenerationCleanupBatches,
  qualifyGenerationKey,
  qualifyGenerationPattern,
  resolveGenerationCleanupBatchSize,
  resolveGenerationCleanupMaxMatches,
  resolveGenerationCleanupTarget,
  stripGenerationPrefix
} from '../../src/internal/CacheStackGeneration'

describe('CacheStackGeneration', () => {
  it('qualifies and strips generation-prefixed keys and patterns', () => {
    expect(generationPrefix(undefined)).toBe('')
    expect(generationPrefix(3)).toBe('v3:')

    expect(qualifyGenerationKey('user:1', undefined)).toBe('user:1')
    expect(qualifyGenerationKey('user:1', 3)).toBe('v3:user:1')

    expect(qualifyGenerationPattern('user:*', undefined)).toBe('user:*')
    expect(qualifyGenerationPattern('user:*', 3)).toBe('v3:user:*')

    expect(stripGenerationPrefix('v3:user:1', 3)).toBe('user:1')
    expect(stripGenerationPrefix('user:1', 3)).toBe('user:1')
    expect(stripGenerationPrefix('v3:user:1', undefined)).toBe('v3:user:1')
  })

  it('resolves generation cleanup targets only when the generation changes and cleanup is enabled', () => {
    expect(
      resolveGenerationCleanupTarget({
        previousGeneration: undefined,
        nextGeneration: 1,
        generationCleanup: true
      })
    ).toBeNull()

    expect(
      resolveGenerationCleanupTarget({
        previousGeneration: 1,
        nextGeneration: 1,
        generationCleanup: true
      })
    ).toBeNull()

    expect(
      resolveGenerationCleanupTarget({
        previousGeneration: 1,
        nextGeneration: 2,
        generationCleanup: false
      })
    ).toBeNull()

    expect(
      resolveGenerationCleanupTarget({
        previousGeneration: 1,
        nextGeneration: 2,
        generationCleanup: true
      })
    ).toBe(1)
  })

  it('uses configured generation cleanup batch sizes and falls back to the default', () => {
    expect(resolveGenerationCleanupBatchSize(undefined)).toBe(500)
    expect(resolveGenerationCleanupBatchSize(true)).toBe(500)
    expect(resolveGenerationCleanupBatchSize({})).toBe(500)
    expect(resolveGenerationCleanupBatchSize({ batchSize: 25 })).toBe(25)
  })

  it('uses a finite generation cleanup discovery limit by default', () => {
    expect(resolveGenerationCleanupMaxMatches(undefined)).toBe(10_000)
    expect(resolveGenerationCleanupMaxMatches(true)).toBe(10_000)
    expect(resolveGenerationCleanupMaxMatches({})).toBe(10_000)
    expect(resolveGenerationCleanupMaxMatches({ maxMatches: 250 })).toBe(250)
    expect(resolveGenerationCleanupMaxMatches({ maxMatches: false })).toBe(false)
  })

  it('plans generation cleanup batches using the resolved batch size', () => {
    expect(planGenerationCleanupBatches([], true)).toEqual([])
    expect(planGenerationCleanupBatches(['v1:a', 'v1:b'], true)).toEqual([['v1:a', 'v1:b']])
    expect(planGenerationCleanupBatches(['v1:a', 'v1:b', 'v1:c'], { batchSize: 2 })).toEqual([
      ['v1:a', 'v1:b'],
      ['v1:c']
    ])
  })
})
