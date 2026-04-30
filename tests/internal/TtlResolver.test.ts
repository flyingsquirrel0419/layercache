import { describe, expect, it, vi } from 'vitest'
import * as TtlResolverModule from '../../src/internal/TtlResolver'
import { TtlResolver } from '../../src/internal/TtlResolver'

describe('TtlResolver', () => {
  it('resolves ttl policy functions and layer-specific overrides', () => {
    const resolver = new TtlResolver({ maxProfileEntries: 100 })

    const ttl = resolver.resolveFreshTtl(
      'user:1',
      'redis',
      'value',
      {
        ttlPolicy: ({ key, value }) => (key === 'user:1' && value === 1 ? 15_000 : 5_000),
        ttl: { redis: 30_000 }
      },
      10_000,
      undefined,
      undefined,
      1
    )

    expect(ttl).toBe(30_000)
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
      const expectedMidnight = Math.max(1, Math.ceil(nextMidnight.getTime() - now.getTime()))

      const expectedNextHour = new Date(now)
      expectedNextHour.setMinutes(60, 0, 0)
      const nextHourMs = Math.max(1, Math.ceil(expectedNextHour.getTime() - now.getTime()))

      expect(midnight).toBe(expectedMidnight)
      expect(nextHour).toBe(nextHourMs)
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
        { ttlPolicy: { alignTo: 300_000 } },
        undefined,
        undefined
      )

      expect(ttl).toBeGreaterThan(0)
      expect(ttl).toBeLessThanOrEqual(300_000)
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
        ttl: 10_000,
        negativeTtl: { memory: 3_000 },
        adaptiveTtl: { hotAfter: 2, step: 2_000, maxTtl: 9_000 }
      },
      undefined,
      undefined
    )

    expect(negative).toBe(7_000)
  })

  it('applies ttl jitter and allows profile deletion and clearing', () => {
    const resolver = new TtlResolver({ maxProfileEntries: 100 })
    const random = vi.spyOn(TtlResolverModule.secureRandom, 'value').mockReturnValue(1)

    resolver.recordAccess('hot')
    resolver.recordAccess('hot')
    resolver.recordAccess('hot')

    const ttl = resolver.resolveFreshTtl(
      'hot',
      'memory',
      'value',
      {
        ttl: 10_000,
        adaptiveTtl: true,
        ttlJitter: 2_000
      },
      undefined,
      undefined
    )

    expect(ttl).toBe(17_000)

    resolver.deleteProfile('hot')
    const withoutProfile = resolver.resolveFreshTtl(
      'hot',
      'memory',
      'value',
      { ttl: 10_000, adaptiveTtl: true },
      undefined,
      undefined
    )
    expect(withoutProfile).toBe(10_000)

    resolver.recordAccess('again')
    resolver.clearProfiles()
    const afterClear = resolver.resolveFreshTtl(
      'again',
      'memory',
      'value',
      { ttl: 10_000, adaptiveTtl: true },
      undefined,
      undefined
    )
    expect(afterClear).toBe(10_000)

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

      const ttlA = resolver.resolveFreshTtl(
        'a',
        'memory',
        'value',
        { ttl: 10_000, adaptiveTtl: true },
        undefined,
        undefined
      )
      const ttlD = resolver.resolveFreshTtl(
        'd',
        'memory',
        'value',
        { ttl: 10_000, adaptiveTtl: true },
        undefined,
        undefined
      )

      expect(ttlA).toBe(10_000)
      expect(ttlD).toBe(10_000)
    } finally {
      vi.useRealTimers()
    }
  })

  it('falls back across defaults and exercises function policy branches', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-05T10:05:10Z'))
    try {
      const resolver = new TtlResolver({ maxProfileEntries: 2 })

      expect(resolver.resolveLayerMs('memory', undefined, { memory: 5_000 }, 3_000)).toBe(5_000)
      expect(resolver.resolveLayerMs('redis', undefined, { memory: 5_000 }, 3_000)).toBe(3_000)
      expect(resolver.applyAdaptiveTtl('missing', 'memory', undefined, true)).toBeUndefined()
      expect(resolver.applyAdaptiveTtl('cold', 'memory', 10, true)).toBe(10)
      expect(resolver.applyJitter(undefined, 1)).toBeUndefined()
      expect(resolver.applyJitter(0, 1)).toBe(0)
      expect(resolver.applyJitter(10_000, 0)).toBe(10_000)

      const functionPolicy = resolver.resolveFreshTtl(
        'fn',
        'memory',
        'value',
        { ttlPolicy: ({ key }) => (key === 'fn' ? 7_000 : 1_000) },
        undefined,
        undefined,
        undefined,
        'value'
      )
      expect(functionPolicy).toBe(7_000)
    } finally {
      vi.useRealTimers()
    }
  })

  it('uses default negative ttl and adaptive defaults when no overrides are present', () => {
    const resolver = new TtlResolver({ maxProfileEntries: 4 })

    expect(resolver.resolveFreshTtl('missing', 'memory', 'empty', {}, undefined, undefined)).toBe(60_000)
    expect(resolver.resolveLayerMs('redis', { memory: 5_000 }, undefined, 3_000)).toBe(3_000)

    resolver.recordAccess('hot')
    resolver.recordAccess('hot')
    resolver.recordAccess('hot')

    expect(
      resolver.resolveFreshTtl('hot', 'memory', 'value', { ttl: 10_000, adaptiveTtl: true }, undefined, undefined)
    ).toBe(15_000)
    expect(resolver.applyAdaptiveTtl('hot', 'memory', 10_000, true)).toBe(15_000)
  })

  it('secureRandom.value returns a number between 0 and 1', () => {
    const value = TtlResolverModule.secureRandom.value()
    expect(value).toBeGreaterThanOrEqual(0)
    expect(value).toBeLessThan(1)
  })
})
