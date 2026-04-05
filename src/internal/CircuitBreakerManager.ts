import type { CacheCircuitBreakerOptions } from '../types'

interface CircuitBreakerState {
  failures: number
  openUntil: number | null
}

interface CircuitBreakerManagerOptions {
  maxEntries: number
}

export class CircuitBreakerManager {
  private readonly breakers = new Map<string, CircuitBreakerState>()
  private readonly maxEntries: number

  constructor(options: CircuitBreakerManagerOptions) {
    this.maxEntries = options.maxEntries
  }

  /**
   * Throws if the circuit is open for the given key.
   * Automatically resets if the cooldown has elapsed.
   */
  assertClosed(key: string, options: CacheCircuitBreakerOptions | undefined): void {
    const state = this.breakers.get(key)
    if (!state?.openUntil) {
      return
    }

    const now = Date.now()
    if (state.openUntil <= now) {
      state.openUntil = null
      state.failures = 0
      this.breakers.set(key, state)
      return
    }

    const remainingMs = state.openUntil - now
    const remainingSecs = Math.ceil(remainingMs / 1_000)
    throw new Error(`Circuit breaker is open for key "${key}" (resets in ${remainingSecs}s).`)
  }

  recordFailure(key: string, options: CacheCircuitBreakerOptions | undefined): void {
    if (!options) {
      return
    }

    const failureThreshold = options.failureThreshold ?? 3
    const cooldownMs = options.cooldownMs ?? 30_000
    const state = this.breakers.get(key) ?? { failures: 0, openUntil: null }
    state.failures += 1

    if (state.failures >= failureThreshold) {
      state.openUntil = Date.now() + cooldownMs
    }

    this.breakers.set(key, state)
    this.pruneIfNeeded()
  }

  recordSuccess(key: string): void {
    this.breakers.delete(key)
  }

  isOpen(key: string): boolean {
    const state = this.breakers.get(key)
    if (!state?.openUntil) {
      return false
    }
    if (state.openUntil <= Date.now()) {
      state.openUntil = null
      state.failures = 0
      return false
    }
    return true
  }

  delete(key: string): void {
    this.breakers.delete(key)
  }

  clear(): void {
    this.breakers.clear()
  }

  tripCount(): number {
    let count = 0
    for (const state of this.breakers.values()) {
      if (state.openUntil !== null) {
        count += 1
      }
    }
    return count
  }

  private pruneIfNeeded(): void {
    if (this.breakers.size <= this.maxEntries) {
      return
    }

    // Prune entries whose circuit is already closed (failures > 0 but not open)
    for (const [key, state] of this.breakers.entries()) {
      if (this.breakers.size <= this.maxEntries) {
        break
      }
      if (!state.openUntil || state.openUntil <= Date.now()) {
        this.breakers.delete(key)
      }
    }

    // If still over limit, remove oldest entries
    for (const key of this.breakers.keys()) {
      if (this.breakers.size <= this.maxEntries) {
        break
      }
      this.breakers.delete(key)
    }
  }
}
