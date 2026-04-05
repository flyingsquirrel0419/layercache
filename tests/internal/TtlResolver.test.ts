import { describe, expect, it, vi } from 'vitest'
import { TtlResolver } from '../../src/internal/TtlResolver'

describe('TtlResolver', () => {
  it('supports aligned ttl policies', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-05T10:05:10Z'))
    const resolver = new TtlResolver({ maxProfileEntries: 100 })

    const ttl = resolver.resolveFreshTtl(
      'key',
      'memory',
      'value',
      { ttlPolicy: { alignTo: 300 } },
      undefined,
      undefined
    )

    expect(ttl).toBeGreaterThan(0)
    expect(ttl).toBeLessThanOrEqual(300)
    vi.useRealTimers()
  })
})
