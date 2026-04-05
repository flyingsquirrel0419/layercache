import { describe, expect, it } from 'vitest'
import { CircuitBreakerManager } from '../../src/internal/CircuitBreakerManager'

describe('CircuitBreakerManager', () => {
  it('opens after the configured threshold and resets on success', () => {
    const manager = new CircuitBreakerManager({ maxEntries: 10 })

    manager.recordFailure('user:1', { failureThreshold: 1, cooldownMs: 1_000 })
    expect(manager.isOpen('user:1')).toBe(true)

    manager.recordSuccess('user:1')
    expect(manager.isOpen('user:1')).toBe(false)
  })
})
