import type { CacheDegradationOptions } from '../types'
import {
  isStoredValueEnvelope,
  refreshStoredEnvelope,
  remainingFreshTtlSeconds,
  remainingStoredTtlSeconds
} from './StoredValue'

export interface FreshReadPolicyPlan {
  refreshedStored: unknown | undefined
  refreshedStoredTtl: number | undefined
  shouldScheduleBackgroundRefresh: boolean
}

export function shouldSkipLayer(degradedUntil: number | undefined, now = Date.now()): boolean {
  return degradedUntil !== undefined && degradedUntil > now
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
  refreshAheadSeconds
}: {
  stored: unknown
  hasFetcher: boolean
  slidingTtl: boolean
  refreshAheadSeconds: number
}): FreshReadPolicyPlan {
  const refreshedStored = slidingTtl && isStoredValueEnvelope(stored) ? refreshStoredEnvelope(stored) : undefined
  const refreshedStoredTtl = refreshedStored ? (remainingStoredTtlSeconds(refreshedStored) ?? undefined) : undefined
  const remainingFreshTtl = remainingFreshTtlSeconds(stored) ?? 0

  return {
    refreshedStored,
    refreshedStoredTtl,
    shouldScheduleBackgroundRefresh:
      hasFetcher && refreshAheadSeconds > 0 && remainingFreshTtl > 0 && remainingFreshTtl <= refreshAheadSeconds
  }
}
