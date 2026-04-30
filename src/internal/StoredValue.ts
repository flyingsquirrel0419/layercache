export interface StoredValueEnvelope {
  __layercache: 1
  kind: 'value' | 'empty'
  value?: unknown
  freshUntil: number | null
  staleUntil: number | null
  errorUntil: number | null
  freshTtlMs?: number | null
  staleWhileRevalidateMs?: number | null
  staleIfErrorMs?: number | null
}

export type StoredValueState = 'fresh' | 'stale-while-revalidate' | 'stale-if-error' | 'expired'

export interface ResolvedStoredValue<T = unknown> {
  state: StoredValueState
  value: T | null
  stored: unknown
  envelope?: StoredValueEnvelope
}

export function isStoredValueEnvelope(value: unknown): value is StoredValueEnvelope {
  if (typeof value !== 'object' || value === null) {
    return false
  }

  const v = value as Record<string, unknown>

  if (v.__layercache !== 1) {
    return false
  }

  if (v.kind !== 'value' && v.kind !== 'empty') {
    return false
  }

  if (v.freshUntil !== null && (!Number.isFinite(v.freshUntil) || typeof v.freshUntil !== 'number')) {
    return false
  }

  if (v.staleUntil !== null && (!Number.isFinite(v.staleUntil) || typeof v.staleUntil !== 'number')) {
    return false
  }

  if (v.errorUntil !== null && (!Number.isFinite(v.errorUntil) || typeof v.errorUntil !== 'number')) {
    return false
  }

  // Reject unreasonably large timestamps (> 10 years from now)
  const maxTimestamp = Date.now() + 10 * 365 * 24 * 60 * 60 * 1_000
  if (typeof v.freshUntil === 'number' && v.freshUntil > maxTimestamp) {
    return false
  }
  if (typeof v.staleUntil === 'number' && v.staleUntil > maxTimestamp) {
    return false
  }
  if (typeof v.errorUntil === 'number' && v.errorUntil > maxTimestamp) {
    return false
  }

  if (v.freshUntil === null && (v.staleUntil !== null || v.errorUntil !== null)) {
    return false
  }

  if (typeof v.freshUntil === 'number' && typeof v.staleUntil === 'number' && v.staleUntil < v.freshUntil) {
    return false
  }

  if (typeof v.freshUntil === 'number' && typeof v.errorUntil === 'number' && v.errorUntil < v.freshUntil) {
    return false
  }

  const maxTtlMs = 10 * 365 * 24 * 60 * 60 * 1_000
  if (!isValidEnvelopeTtlMs(v.freshTtlMs, maxTtlMs)) {
    return false
  }
  if (!isValidEnvelopeTtlMs(v.staleWhileRevalidateMs, maxTtlMs)) {
    return false
  }
  if (!isValidEnvelopeTtlMs(v.staleIfErrorMs, maxTtlMs)) {
    return false
  }

  if (v.freshTtlMs == null && (v.staleWhileRevalidateMs != null || v.staleIfErrorMs != null)) {
    return false
  }

  return true
}

export function createStoredValueEnvelope(options: {
  kind: 'value' | 'empty'
  value?: unknown
  freshTtlMs?: number
  staleWhileRevalidateMs?: number
  staleIfErrorMs?: number
  now?: number
}): StoredValueEnvelope {
  const now = options.now ?? Date.now()
  const freshTtlMs = normalizePositiveMs(options.freshTtlMs)
  const staleWhileRevalidateMs = normalizePositiveMs(options.staleWhileRevalidateMs)
  const staleIfErrorMs = normalizePositiveMs(options.staleIfErrorMs)

  const freshUntil = freshTtlMs ? now + freshTtlMs : null
  const staleUntil = freshUntil && staleWhileRevalidateMs ? freshUntil + staleWhileRevalidateMs : null
  const errorUntil = freshUntil && staleIfErrorMs ? freshUntil + staleIfErrorMs : null

  return {
    __layercache: 1,
    kind: options.kind,
    value: options.value,
    freshUntil,
    staleUntil,
    errorUntil,
    freshTtlMs: freshTtlMs ?? null,
    staleWhileRevalidateMs: staleWhileRevalidateMs ?? null,
    staleIfErrorMs: staleIfErrorMs ?? null
  }
}

export function resolveStoredValue<T>(stored: unknown, now = Date.now()): ResolvedStoredValue<T> {
  if (!isStoredValueEnvelope(stored)) {
    return { state: 'fresh', value: stored as T, stored }
  }

  if (stored.freshUntil === null || stored.freshUntil > now) {
    return { state: 'fresh', value: unwrapStoredValue<T>(stored), stored, envelope: stored }
  }

  if (stored.staleUntil !== null && stored.staleUntil > now) {
    return { state: 'stale-while-revalidate', value: unwrapStoredValue<T>(stored), stored, envelope: stored }
  }

  if (stored.errorUntil !== null && stored.errorUntil > now) {
    return { state: 'stale-if-error', value: unwrapStoredValue<T>(stored), stored, envelope: stored }
  }

  return { state: 'expired', value: null, stored, envelope: stored }
}

export function unwrapStoredValue<T>(stored: unknown): T | null {
  if (!isStoredValueEnvelope(stored)) {
    return stored as T
  }

  if (stored.kind === 'empty') {
    return null
  }

  return (stored.value ?? null) as T | null
}

export function remainingStoredTtlMs(stored: unknown, now = Date.now()): number | undefined {
  if (!isStoredValueEnvelope(stored)) {
    return undefined
  }

  const expiry = maxExpiry(stored)
  if (expiry === null) {
    return undefined
  }

  const remainingMs = expiry - now
  if (remainingMs <= 0) {
    return 1
  }

  return Math.max(1, Math.ceil(remainingMs))
}

export function remainingFreshTtlMs(stored: unknown, now = Date.now()): number | undefined {
  if (!isStoredValueEnvelope(stored) || stored.freshUntil === null) {
    return undefined
  }

  const remainingMs = stored.freshUntil - now
  if (remainingMs <= 0) {
    return 0
  }

  return Math.max(1, Math.ceil(remainingMs))
}

export function refreshStoredEnvelope(stored: unknown, now = Date.now()): unknown {
  if (!isStoredValueEnvelope(stored)) {
    return stored
  }

  return createStoredValueEnvelope({
    kind: stored.kind,
    value: stored.value,
    freshTtlMs: stored.freshTtlMs ?? undefined,
    staleWhileRevalidateMs: stored.staleWhileRevalidateMs ?? undefined,
    staleIfErrorMs: stored.staleIfErrorMs ?? undefined,
    now
  })
}

function maxExpiry(stored: StoredValueEnvelope): number | null {
  const values = [stored.freshUntil, stored.staleUntil, stored.errorUntil].filter(
    (value): value is number => value !== null
  )

  if (values.length === 0) {
    return null
  }

  return Math.max(...values)
}

function normalizePositiveMs(value: number | undefined): number | undefined {
  if (!value || value <= 0) {
    return undefined
  }

  return value
}

function isValidEnvelopeTtlMs(value: unknown, maxTtlMs: number): boolean {
  if (value == null) {
    return true
  }

  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= maxTtlMs
}
