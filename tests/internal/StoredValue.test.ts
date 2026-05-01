import { describe, expect, it } from 'vitest'
import {
  createStoredValueEnvelope,
  expireStoredEnvelope,
  isStoredValueEnvelope,
  refreshStoredEnvelope,
  remainingFreshTtlSeconds,
  remainingStoredTtlSeconds,
  resolveStoredValue,
  unwrapStoredValue
} from '../../src/internal/StoredValue'

describe('StoredValue', () => {
  it('rejects envelopes with unbounded stale/error windows', () => {
    const now = Date.now()
    const future = now + 11 * 365 * 24 * 60 * 60 * 1_000

    expect(
      isStoredValueEnvelope({
        __layercache: 1,
        kind: 'value',
        value: { id: 1 },
        freshUntil: now + 1_000,
        staleUntil: future,
        errorUntil: future
      })
    ).toBe(false)
  })

  it('rejects envelopes with stale/error windows before fresh expiry', () => {
    const now = Date.now()

    expect(
      isStoredValueEnvelope({
        __layercache: 1,
        kind: 'value',
        value: { id: 1 },
        freshUntil: now + 5_000,
        staleUntil: now + 1_000,
        errorUntil: now + 2_000
      })
    ).toBe(false)
  })

  it('treats malformed envelope ordering as plain values when resolving', () => {
    const malformed = {
      __layercache: 1,
      kind: 'value',
      value: { id: 1 },
      freshUntil: null,
      staleUntil: Date.now() + 1_000,
      errorUntil: null
    }

    expect(isStoredValueEnvelope(malformed)).toBe(false)
    expect(resolveStoredValue(malformed)).toEqual({
      state: 'fresh',
      value: malformed,
      stored: malformed
    })
  })

  it('rejects envelopes with invalid ttl metadata', () => {
    const now = Date.now()

    expect(
      isStoredValueEnvelope({
        __layercache: 1,
        kind: 'value',
        value: { id: 1 },
        freshUntil: now + 1_000,
        staleUntil: now + 2_000,
        errorUntil: null,
        freshTtlSeconds: Number.POSITIVE_INFINITY
      })
    ).toBe(false)

    expect(
      isStoredValueEnvelope({
        __layercache: 1,
        kind: 'value',
        value: { id: 1 },
        freshUntil: now + 1_000,
        staleUntil: now + 2_000,
        errorUntil: null,
        freshTtlSeconds: 60,
        staleWhileRevalidateSeconds: 999_999_999
      })
    ).toBe(false)
  })

  it('rejects envelopes with invalid timestamp metadata', () => {
    const now = Date.now()
    const future = now + 11 * 365 * 24 * 60 * 60 * 1_000

    expect(
      isStoredValueEnvelope({
        __layercache: 1,
        kind: 'invalid',
        value: { id: 1 },
        freshUntil: now + 1_000,
        staleUntil: null,
        errorUntil: null
      })
    ).toBe(false)

    expect(
      isStoredValueEnvelope({
        __layercache: 1,
        kind: 'value',
        value: { id: 1 },
        freshUntil: 'bad',
        staleUntil: null,
        errorUntil: null
      })
    ).toBe(false)

    expect(
      isStoredValueEnvelope({
        __layercache: 1,
        kind: 'value',
        value: { id: 1 },
        freshUntil: now + 1_000,
        staleUntil: 'bad',
        errorUntil: null
      })
    ).toBe(false)

    expect(
      isStoredValueEnvelope({
        __layercache: 1,
        kind: 'value',
        value: { id: 1 },
        freshUntil: now + 1_000,
        staleUntil: null,
        errorUntil: 'bad'
      })
    ).toBe(false)

    expect(
      isStoredValueEnvelope({
        __layercache: 1,
        kind: 'value',
        value: { id: 1 },
        freshUntil: future,
        staleUntil: null,
        errorUntil: null
      })
    ).toBe(false)

    expect(
      isStoredValueEnvelope({
        __layercache: 1,
        kind: 'value',
        value: { id: 1 },
        freshUntil: now + 1_000,
        staleUntil: null,
        errorUntil: future
      })
    ).toBe(false)

    expect(
      isStoredValueEnvelope({
        __layercache: 1,
        kind: 'value',
        value: { id: 1 },
        freshUntil: now + 5_000,
        staleUntil: null,
        errorUntil: now + 1_000
      })
    ).toBe(false)
  })

  it('rejects stale metadata without a fresh ttl baseline', () => {
    const now = Date.now()

    expect(
      isStoredValueEnvelope({
        __layercache: 1,
        kind: 'value',
        value: { id: 1 },
        freshUntil: now + 1_000,
        staleUntil: now + 2_000,
        errorUntil: null,
        freshTtlSeconds: null,
        staleWhileRevalidateSeconds: 30
      })
    ).toBe(false)
  })

  it('rejects stale-if-error ttl metadata without a valid finite value', () => {
    const now = Date.now()

    expect(
      isStoredValueEnvelope({
        __layercache: 1,
        kind: 'value',
        value: { id: 1 },
        freshUntil: now + 1_000,
        staleUntil: now + 2_000,
        errorUntil: null,
        staleIfErrorSeconds: Number.POSITIVE_INFINITY
      })
    ).toBe(false)
  })

  it('creates envelopes and resolves fresh stale error and expired states', () => {
    const now = Date.now()
    const fresh = createStoredValueEnvelope({
      kind: 'value',
      value: { id: 1 },
      freshTtlSeconds: 10,
      staleWhileRevalidateSeconds: 5,
      staleIfErrorSeconds: 7,
      now
    })

    expect(resolveStoredValue(fresh, now)).toEqual({
      state: 'fresh',
      value: { id: 1 },
      stored: fresh,
      envelope: fresh
    })
    expect(resolveStoredValue(fresh, now + 11_000).state).toBe('stale-while-revalidate')
    expect(resolveStoredValue(fresh, now + 16_000).state).toBe('stale-if-error')
    expect(resolveStoredValue(fresh, now + 18_000).state).toBe('expired')
  })

  it('unwraps empty envelopes and computes remaining ttl helpers', () => {
    const now = Date.now()
    const empty = createStoredValueEnvelope({
      kind: 'empty',
      freshTtlSeconds: 5,
      staleWhileRevalidateSeconds: 5,
      now
    })

    expect(unwrapStoredValue(empty)).toBeNull()
    expect(remainingFreshTtlSeconds(empty, now)).toBe(5)
    expect(remainingFreshTtlSeconds(empty, now + 6_000)).toBe(0)
    expect(remainingStoredTtlSeconds(empty, now)).toBe(10)
    expect(remainingStoredTtlSeconds(empty, now + 11_000)).toBe(1)
    expect(remainingStoredTtlSeconds('plain')).toBeUndefined()
  })

  it('returns undefined ttl helpers for envelopes without expiry metadata', () => {
    const now = Date.now()
    const empty = createStoredValueEnvelope({
      kind: 'empty',
      now
    })

    expect(remainingStoredTtlSeconds(empty, now)).toBeUndefined()
    expect(remainingFreshTtlSeconds(empty, now)).toBeUndefined()
  })

  it('refreshes envelopes and leaves plain values untouched', () => {
    const now = Date.now()
    const envelope = createStoredValueEnvelope({
      kind: 'value',
      value: 'ok',
      freshTtlSeconds: 5,
      staleIfErrorSeconds: 5,
      now
    })

    const refreshed = refreshStoredEnvelope(envelope, now + 10_000)
    expect(isStoredValueEnvelope(refreshed)).toBe(true)
    expect((refreshed as { freshUntil: number }).freshUntil).toBe(now + 15_000)
    expect(refreshStoredEnvelope('plain')).toBe('plain')
  })

  it('expires envelope freshness while preserving original stale deadlines and plain values', () => {
    const now = Date.now()
    const envelope = createStoredValueEnvelope({
      kind: 'value',
      value: { id: 1 },
      freshTtlSeconds: 60,
      staleWhileRevalidateSeconds: 30,
      staleIfErrorSeconds: 120,
      now
    })

    const expired = expireStoredEnvelope(envelope, now + 10_000)

    expect(resolveStoredValue(expired, now + 10_000)).toEqual({
      state: 'stale-while-revalidate',
      value: { id: 1 },
      stored: expired,
      envelope: expired
    })
    expect((expired as { freshUntil: number }).freshUntil).toBe(now + 10_000)
    expect((expired as { staleUntil: number }).staleUntil).toBe(now + 90_000)
    expect((expired as { errorUntil: number }).errorUntil).toBe(now + 180_000)
    expect(expireStoredEnvelope('plain')).toBe('plain')
  })

  it('does not revive stale-if-error entries back into stale-while-revalidate', () => {
    const now = Date.now()
    const envelope = createStoredValueEnvelope({
      kind: 'value',
      value: { id: 1 },
      freshTtlSeconds: 10,
      staleWhileRevalidateSeconds: 5,
      staleIfErrorSeconds: 20,
      now
    })

    const expired = expireStoredEnvelope(envelope, now + 16_000)

    expect(resolveStoredValue(expired, now + 16_000)).toEqual({
      state: 'stale-if-error',
      value: { id: 1 },
      stored: expired,
      envelope: expired
    })
    expect((expired as { freshUntil: number }).freshUntil).toBe(now + 15_000)
    expect((expired as { staleUntil: number }).staleUntil).toBe(now + 15_000)
    expect((expired as { errorUntil: number }).errorUntil).toBe(now + 30_000)
    expect(expireStoredEnvelope('plain')).toBe('plain')
  })
})
