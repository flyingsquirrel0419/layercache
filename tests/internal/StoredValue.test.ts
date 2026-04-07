import { describe, expect, it } from 'vitest'
import { isStoredValueEnvelope, resolveStoredValue } from '../../src/internal/StoredValue'

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
})
