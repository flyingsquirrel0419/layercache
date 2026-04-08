import { describe, expect, it, vi } from 'vitest'
import { TtlResolver } from '../../src/internal/TtlResolver'

describe('TtlResolver', () => {
  it('resolves ttl policy functions and layer-specific overrides', () => {
    const resolver = new TtlResolver({ maxProfileEntries: 100 })

    const ttl = resolver.resolveFreshTtl(
      'user:1',
      'redis',
      'value',
      {
        ttlPolicy: ({ key, value }) => (key === 'user:1' && value === 1 ? 15 : 5),
        ttl: { redis: 30 }
      },
      10,
      undefined,
      undefined,
      1
    )

    expect(ttl).toBe(30)
  })

  it('supports until-midnight and next-hour policies', () => {
    vi.useFakeTimers()
    const now = new Date('2026-04-05T10:05:10Z')
    vi.setSystemTime(now)
    try {
      const resolver = new TtlResolver({ maxProfileEntries: 100 })

      const midnight = resolver.resolveFreshTtl(
        'midnight',
        'memory',
        'value',
        { ttlPolicy: 'until-midnight' },
        5,
        undefined
      )
      const nextHour = resolver.resolveFreshTtl('hour', 'memory', 'value', { ttlPolicy: 'next-hour' }, 5, undefined)

      const nextMidnight = new Date(now)
      nextMidnight.setHours(24, 0, 0, 0)
      const expectedMidnight = Math.max(1, Math.ceil((nextMidnight.getTime() - now.getTime()) / 1_000))

      const expectedNextHour = new Date(now)
      expectedNextHour.setMinutes(60, 0, 0)
      const nextHourSeconds = Math.max(1, Math.ceil((expectedNextHour.getTime() - now.getTime()) / 1_000))

      expect(midnight).toBe(expectedMidnight)
      expect(nextHour).toBe(nextHourSeconds)
    } finally {
      vi.useRealTimers()
    }
  })

  it('supports aligned ttl policies', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-05T10:05:10Z'))
    try {
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
    } finally {
      vi.useRealTimers()
    }
  })

  it('supports negative cache ttl fallback and adaptive ttl growth', () => {
    const resolver = new TtlResolver({ maxProfileEntries: 100 })
    resolver.recordAccess('missing')
    resolver.recordAccess('missing')
    resolver.recordAccess('missing')
    resolver.recordAccess('missing')

    const negative = resolver.resolveFreshTtl(
      'missing',
      'memory',
      'empty',
      {
        ttl: 10,
        negativeTtl: { memory: 3 },
        adaptiveTtl: { hotAfter: 2, step: 2, maxTtl: 9 }
      },
      undefined,
      undefined
    )

    expect(negative).toBe(7)
  })

  it('applies ttl jitter and allows profile deletion and clearing', () => {
    const resolver = new TtlResolver({ maxProfileEntries: 100 })
    const random = vi.spyOn(Math, 'random').mockReturnValue(1)

    resolver.recordAccess('hot')
    resolver.recordAccess('hot')
    resolver.recordAccess('hot')

    const ttl = resolver.resolveFreshTtl(
      'hot',
      'memory',
      'value',
      {
        ttl: 10,
        adaptiveTtl: true,
        ttlJitter: 2
      },
      undefined,
      undefined
    )

    expect(ttl).toBe(17)

    resolver.deleteProfile('hot')
    const withoutProfile = resolver.resolveFreshTtl(
      'hot',
      'memory',
      'value',
      { ttl: 10, adaptiveTtl: true },
      undefined,
      undefined
    )
    expect(withoutProfile).toBe(10)

    resolver.recordAccess('again')
    resolver.clearProfiles()
    const afterClear = resolver.resolveFreshTtl(
      'again',
      'memory',
      'value',
      { ttl: 10, adaptiveTtl: true },
      undefined,
      undefined
    )
    expect(afterClear).toBe(10)

    random.mockRestore()
  })

  it('prunes least recently accessed profiles when capacity is exceeded', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-05T10:00:00Z'))
    try {
      const resolver = new TtlResolver({ maxProfileEntries: 3 })

      resolver.recordAccess('a')
      vi.advanceTimersByTime(1)
      resolver.recordAccess('b')
      vi.advanceTimersByTime(1)
      resolver.recordAccess('c')
      vi.advanceTimersByTime(1)
      resolver.recordAccess('d')

      const ttlA = resolver.resolveFreshTtl('a', 'memory', 'value', { ttl: 10, adaptiveTtl: true }, undefined, undefined)
      const ttlD = resolver.resolveFreshTtl('d', 'memory', 'value', { ttl: 10, adaptiveTtl: true }, undefined, undefined)

      expect(ttlA).toBe(10)
      expect(ttlD).toBe(10)
    } finally {
      vi.useRealTimers()
    }
  })

  it('falls back across defaults and exercises function policy branches', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-05T10:05:10Z'))
    try {
      const resolver = new TtlResolver({ maxProfileEntries: 2 })

      expect(resolver.resolveLayerSeconds('memory', undefined, { memory: 5 }, 3)).toBe(5)
      expect(resolver.resolveLayerSeconds('redis', undefined, { memory: 5 }, 3)).toBe(3)
      expect(resolver.applyAdaptiveTtl('missing', 'memory', undefined, true)).toBeUndefined()
      expect(resolver.applyAdaptiveTtl('cold', 'memory', 10, true)).toBe(10)
      expect(resolver.applyJitter(undefined, 1)).toBeUndefined()
      expect(resolver.applyJitter(0, 1)).toBe(0)
      expect(resolver.applyJitter(10, 0)).toBe(10)

      const functionPolicy = resolver.resolveFreshTtl(
        'fn',
        'memory',
        'value',
        { ttlPolicy: ({ key }) => (key === 'fn' ? 7 : 1) },
        undefined,
        undefined,
        undefined,
        'value'
      )
      expect(functionPolicy).toBe(7)
    } finally {
      vi.useRealTimers()
    }
  })

  it('uses default negative ttl and adaptive defaults when no overrides are present', () => {
    const resolver = new TtlResolver({ maxProfileEntries: 4 })

    expect(resolver.resolveFreshTtl('missing', 'memory', 'empty', {}, undefined, undefined)).toBe(60)
    expect(resolver.resolveLayerSeconds('redis', { memory: 5 }, undefined, 3)).toBe(3)

    resolver.recordAccess('hot')
    resolver.recordAccess('hot')
    resolver.recordAccess('hot')

    expect(
      resolver.resolveFreshTtl('hot', 'memory', 'value', { ttl: 10, adaptiveTtl: true }, undefined, undefined)
    ).toBe(15)
    expect(resolver.applyAdaptiveTtl('hot', 'memory', 10, true)).toBe(15)
  })
})
