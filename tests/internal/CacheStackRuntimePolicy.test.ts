import { describe, expect, it } from 'vitest'
import {
  planFreshReadPolicies,
  resolveRecoverableLayerFailure,
  shouldSkipLayer,
  shouldStartBackgroundRefresh
} from '../../src/internal/CacheStackRuntimePolicy'
import { createStoredValueEnvelope, remainingStoredTtlMs } from '../../src/internal/StoredValue'

describe('CacheStackRuntimePolicy', () => {
  it('skips degraded layers only while their retry window is still open', () => {
    expect(shouldSkipLayer(undefined, 1_000)).toBe(false)
    expect(shouldSkipLayer(999, 1_000)).toBe(false)
    expect(shouldSkipLayer(1_001, 1_000)).toBe(true)
  })

  it('blocks background refresh scheduling while disconnecting or when a refresh is already in flight', () => {
    expect(shouldStartBackgroundRefresh({ isDisconnecting: true, hasRefreshInFlight: false })).toBe(false)
    expect(shouldStartBackgroundRefresh({ isDisconnecting: false, hasRefreshInFlight: true })).toBe(false)
    expect(shouldStartBackgroundRefresh({ isDisconnecting: false, hasRefreshInFlight: false })).toBe(true)
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
      freshTtlMs: 2_000,
      staleWhileRevalidateMs: 10_000
    })

    const plan = planFreshReadPolicies({
      stored,
      hasFetcher: true,
      slidingTtl: true,
      refreshAheadMs: 5_000
    })

    expect(plan.shouldScheduleBackgroundRefresh).toBe(true)
    expect(plan.refreshedStored).toBeDefined()
    expect(plan.refreshedStoredTtl).toBeDefined()
    expect(plan.refreshedStoredTtl).toBeGreaterThanOrEqual(remainingStoredTtlMs(stored) ?? 0)
  })

  it('avoids refresh planning when the value is not refreshable or fresh enough', () => {
    const staleStored = createStoredValueEnvelope({
      kind: 'value',
      value: { id: 1 },
      freshTtlMs: 1_000,
      staleWhileRevalidateMs: 5_000,
      now: Date.now() - 2_000
    })

    expect(
      planFreshReadPolicies({
        stored: { plain: true },
        hasFetcher: true,
        slidingTtl: true,
        refreshAheadMs: 5_000
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
        refreshAheadMs: 5_000
      }).shouldScheduleBackgroundRefresh
    ).toBe(false)

    expect(
      planFreshReadPolicies({
        stored: createStoredValueEnvelope({
          kind: 'value',
          value: { id: 2 },
          freshTtlMs: 10_000
        }),
        hasFetcher: false,
        slidingTtl: false,
        refreshAheadMs: 5_000
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
        refreshAheadMs: 0
      }).refreshedStoredTtl
    ).toBeUndefined()
  })
})
