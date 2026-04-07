import { describe, expect, it, vi } from 'vitest'
import { CircuitBreakerManager } from '../../src/internal/CircuitBreakerManager'

describe('CircuitBreakerManager', () => {
  it('opens after the configured threshold and resets on success', () => {
    const manager = new CircuitBreakerManager({ maxEntries: 10 })

    manager.recordFailure('user:1', { failureThreshold: 1, cooldownMs: 1_000 })
    expect(manager.isOpen('user:1')).toBe(true)

    manager.recordSuccess('user:1')
    expect(manager.isOpen('user:1')).toBe(false)
  })

  it('does nothing when no breaker options are provided', () => {
    const manager = new CircuitBreakerManager({ maxEntries: 10 })

    manager.recordFailure('user:1', undefined)

    expect(manager.isOpen('user:1')).toBe(false)
    expect(() => manager.assertClosed('user:1', undefined)).not.toThrow()
  })

  it('throws while open and automatically resets after cooldown elapses', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-07T00:00:00Z'))
    const manager = new CircuitBreakerManager({ maxEntries: 10 })

    manager.recordFailure('user:1', { failureThreshold: 1, cooldownMs: 2_000 })
    expect(() => manager.assertClosed('user:1', { failureThreshold: 1, cooldownMs: 2_000 })).toThrow(/resets in 2s/i)

    vi.advanceTimersByTime(2_001)

    expect(() => manager.assertClosed('user:1', { failureThreshold: 1, cooldownMs: 2_000 })).not.toThrow()
    expect(manager.isOpen('user:1')).toBe(false)
    vi.useRealTimers()
  })

  it('tracks trip counts and supports delete and clear', () => {
    const manager = new CircuitBreakerManager({ maxEntries: 10 })

    manager.recordFailure('a', { failureThreshold: 1, cooldownMs: 1_000 })
    manager.recordFailure('b', { failureThreshold: 2, cooldownMs: 1_000 })
    manager.recordFailure('b', { failureThreshold: 2, cooldownMs: 1_000 })
    expect(manager.tripCount()).toBe(2)

    manager.delete('a')
    expect(manager.tripCount()).toBe(1)

    manager.clear()
    expect(manager.tripCount()).toBe(0)
  })

  it('prunes expired entries first and then oldest entries when over capacity', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-07T00:00:00Z'))
    const manager = new CircuitBreakerManager({ maxEntries: 2 })

    manager.recordFailure('expired', { failureThreshold: 1, cooldownMs: 100 })
    vi.advanceTimersByTime(200)
    manager.recordFailure('oldest', { failureThreshold: 1, cooldownMs: 1_000 })
    vi.advanceTimersByTime(1)
    manager.recordFailure('newest', { failureThreshold: 1, cooldownMs: 1_000 })
    vi.advanceTimersByTime(1)
    manager.recordFailure('trigger', { failureThreshold: 1, cooldownMs: 1_000 })
    vi.advanceTimersByTime(1)
    manager.recordFailure('overflow', { failureThreshold: 1, cooldownMs: 1_000 })

    expect(manager.isOpen('expired')).toBe(false)
    expect(manager.isOpen('oldest')).toBe(false)
    expect(manager.isOpen('trigger')).toBe(true)
    expect(manager.isOpen('overflow')).toBe(true)
    vi.useRealTimers()
  })

  it('uses default threshold/cooldown values and ignores closed breakers in trip counts', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-07T00:00:00Z'))
    const manager = new CircuitBreakerManager({ maxEntries: 10 })

    manager.recordFailure('default', {})
    manager.recordFailure('default', {})
    expect(manager.isOpen('default')).toBe(false)
    manager.recordFailure('default', {})
    expect(manager.isOpen('default')).toBe(true)
    expect(manager.tripCount()).toBe(1)

    vi.advanceTimersByTime(30_001)
    expect(manager.isOpen('default')).toBe(false)
    expect(manager.tripCount()).toBe(0)
    vi.useRealTimers()
  })
})
