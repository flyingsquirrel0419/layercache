export interface StoredValueEnvelope {
  __layercache: 1
  kind: 'value' | 'empty'
  value?: unknown
  freshUntil: number | null
  staleUntil: number | null
  errorUntil: number | null
  freshTtlSeconds?: number | null
  staleWhileRevalidateSeconds?: number | null
  staleIfErrorSeconds?: number | null
}

export type StoredValueState = 'fresh' | 'stale-while-revalidate' | 'stale-if-error' | 'expired'

export interface ResolvedStoredValue<T = unknown> {
  state: StoredValueState
  value: T | null
  stored: unknown
  envelope?: StoredValueEnvelope
}

export function isStoredValueEnvelope(value: unknown): value is StoredValueEnvelope {
  return (
    typeof value === 'object' &&
    value !== null &&
    '__layercache' in value &&
    (value as Record<string, unknown>).__layercache === 1 &&
    'kind' in value
  )
}

export function createStoredValueEnvelope(options: {
  kind: 'value' | 'empty'
  value?: unknown
  freshTtlSeconds?: number
  staleWhileRevalidateSeconds?: number
  staleIfErrorSeconds?: number
  now?: number
}): StoredValueEnvelope {
  const now = options.now ?? Date.now()
  const freshTtlSeconds = normalizePositiveSeconds(options.freshTtlSeconds)
  const staleWhileRevalidateSeconds = normalizePositiveSeconds(options.staleWhileRevalidateSeconds)
  const staleIfErrorSeconds = normalizePositiveSeconds(options.staleIfErrorSeconds)

  const freshUntil = freshTtlSeconds ? now + freshTtlSeconds * 1_000 : null
  const staleUntil = freshUntil && staleWhileRevalidateSeconds
    ? freshUntil + staleWhileRevalidateSeconds * 1_000
    : null
  const errorUntil = freshUntil && staleIfErrorSeconds
    ? freshUntil + staleIfErrorSeconds * 1_000
    : null

  return {
    __layercache: 1,
    kind: options.kind,
    value: options.value,
    freshUntil,
    staleUntil,
    errorUntil,
    freshTtlSeconds: freshTtlSeconds ?? null,
    staleWhileRevalidateSeconds: staleWhileRevalidateSeconds ?? null,
    staleIfErrorSeconds: staleIfErrorSeconds ?? null
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

export function remainingStoredTtlSeconds(stored: unknown, now = Date.now()): number | undefined {
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

  return Math.max(1, Math.ceil(remainingMs / 1_000))
}

export function remainingFreshTtlSeconds(stored: unknown, now = Date.now()): number | undefined {
  if (!isStoredValueEnvelope(stored) || stored.freshUntil === null) {
    return undefined
  }

  const remainingMs = stored.freshUntil - now
  if (remainingMs <= 0) {
    return 0
  }

  return Math.max(1, Math.ceil(remainingMs / 1_000))
}

export function refreshStoredEnvelope(stored: unknown, now = Date.now()): unknown {
  if (!isStoredValueEnvelope(stored)) {
    return stored
  }

  return createStoredValueEnvelope({
    kind: stored.kind,
    value: stored.value,
    freshTtlSeconds: stored.freshTtlSeconds ?? undefined,
    staleWhileRevalidateSeconds: stored.staleWhileRevalidateSeconds ?? undefined,
    staleIfErrorSeconds: stored.staleIfErrorSeconds ?? undefined,
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

function normalizePositiveSeconds(value: number | undefined): number | undefined {
  if (!value || value <= 0) {
    return undefined
  }

  return value
}
