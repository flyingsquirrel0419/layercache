import type { CacheDegradationOptions } from '../types'
import { isStoredValueEnvelope, refreshStoredEnvelope, remainingFreshTtlMs, remainingStoredTtlMs } from './StoredValue'

export interface FreshReadPolicyPlan {
  refreshedStored: unknown | undefined
  refreshedStoredTtl: number | undefined
  shouldScheduleBackgroundRefresh: boolean
}

export function shouldSkipLayer(degradedUntil: number | undefined, now = Date.now()): boolean {
  return degradedUntil !== undefined && degradedUntil > now
}

export function shouldStartBackgroundRefresh({
  isDisconnecting,
  hasRefreshInFlight
}: {
  isDisconnecting: boolean
  hasRefreshInFlight: boolean
}): boolean {
  return !isDisconnecting && !hasRefreshInFlight
}

export function resolveRecoverableLayerFailure(
  gracefulDegradation: boolean | CacheDegradationOptions | undefined,
  now = Date.now()
): { degrade: false } | { degrade: true; degradedUntil: number } {
  if (!gracefulDegradation) {
    return { degrade: false }
  }

  const retryAfterMs = typeof gracefulDegradation === 'object' ? (gracefulDegradation.retryAfterMs ?? 10_000) : 10_000
  return {
    degrade: true,
    degradedUntil: now + retryAfterMs
  }
}

export function planFreshReadPolicies({
  stored,
  hasFetcher,
  slidingTtl,
  refreshAheadMs
}: {
  stored: unknown
  hasFetcher: boolean
  slidingTtl: boolean
  refreshAheadMs: number
}): FreshReadPolicyPlan {
  const refreshedStored = slidingTtl && isStoredValueEnvelope(stored) ? refreshStoredEnvelope(stored) : undefined
  const refreshedStoredTtl = refreshedStored ? (remainingStoredTtlMs(refreshedStored) ?? undefined) : undefined
  const remainingFreshTtl = remainingFreshTtlMs(stored) ?? 0

  return {
    refreshedStored,
    refreshedStoredTtl,
    shouldScheduleBackgroundRefresh:
      hasFetcher && refreshAheadMs > 0 && remainingFreshTtl > 0 && remainingFreshTtl <= refreshAheadMs
  }
}
