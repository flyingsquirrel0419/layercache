import { describe, expect, it } from 'vitest'
import {
  planFreshReadPolicies,
  resolveRecoverableLayerFailure,
  shouldSkipLayer
} from '../../src/internal/CacheStackRuntimePolicy'
import { createStoredValueEnvelope, remainingStoredTtlSeconds } from '../../src/internal/StoredValue'

describe('CacheStackRuntimePolicy', () => {
  it('skips degraded layers only while their retry window is still open', () => {
    expect(shouldSkipLayer(undefined, 1_000)).toBe(false)
    expect(shouldSkipLayer(999, 1_000)).toBe(false)
    expect(shouldSkipLayer(1_001, 1_000)).toBe(true)
  })

  it('resolves recoverable layer failure plans for disabled, default, and custom degradation', () => {
    expect(resolveRecoverableLayerFailure(undefined, 5_000)).toEqual({ degrade: false })
    expect(resolveRecoverableLayerFailure(false, 5_000)).toEqual({ degrade: false })
    expect(resolveRecoverableLayerFailure(true, 5_000)).toEqual({
      degrade: true,
      degradedUntil: 15_000
    })
    expect(resolveRecoverableLayerFailure({}, 5_000)).toEqual({
      degrade: true,
      degradedUntil: 15_000
    })
    expect(resolveRecoverableLayerFailure({ retryAfterMs: 250 }, 5_000)).toEqual({
      degrade: true,
      degradedUntil: 5_250
    })
  })

  it('plans sliding-ttl refreshes and refresh-ahead scheduling from fresh stored values', () => {
    const stored = createStoredValueEnvelope({
      kind: 'value',
      value: { id: 1 },
      freshTtlSeconds: 2,
      staleWhileRevalidateSeconds: 10
    })

    const plan = planFreshReadPolicies({
      stored,
      hasFetcher: true,
      slidingTtl: true,
      refreshAheadSeconds: 5
    })

    expect(plan.shouldScheduleBackgroundRefresh).toBe(true)
    expect(plan.refreshedStored).toBeDefined()
    expect(plan.refreshedStoredTtl).toBeDefined()
    expect(plan.refreshedStoredTtl).toBeGreaterThanOrEqual(remainingStoredTtlSeconds(stored) ?? 0)
  })

  it('avoids refresh planning when the value is not refreshable or fresh enough', () => {
    const staleStored = createStoredValueEnvelope({
      kind: 'value',
      value: { id: 1 },
      freshTtlSeconds: 1,
      staleWhileRevalidateSeconds: 5,
      now: Date.now() - 2_000
    })

    expect(
      planFreshReadPolicies({
        stored: { plain: true },
        hasFetcher: true,
        slidingTtl: true,
        refreshAheadSeconds: 5
      })
    ).toEqual({
      refreshedStored: undefined,
      refreshedStoredTtl: undefined,
      shouldScheduleBackgroundRefresh: false
    })

    expect(
      planFreshReadPolicies({
        stored: staleStored,
        hasFetcher: true,
        slidingTtl: false,
        refreshAheadSeconds: 5
      }).shouldScheduleBackgroundRefresh
    ).toBe(false)

    expect(
      planFreshReadPolicies({
        stored: createStoredValueEnvelope({
          kind: 'value',
          value: { id: 2 },
          freshTtlSeconds: 10
        }),
        hasFetcher: false,
        slidingTtl: false,
        refreshAheadSeconds: 5
      }).shouldScheduleBackgroundRefresh
    ).toBe(false)

    expect(
      planFreshReadPolicies({
        stored: createStoredValueEnvelope({
          kind: 'value',
          value: { id: 3 }
        }),
        hasFetcher: true,
        slidingTtl: true,
        refreshAheadSeconds: 0
      }).refreshedStoredTtl
    ).toBeUndefined()
  })
})
