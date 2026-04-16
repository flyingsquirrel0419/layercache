import type { CacheCircuitBreakerOptions } from '../types'

interface CircuitBreakerState {
  failures: number
  openUntil: number | null
  createdAt: number
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
      this.breakers.delete(key)
      return
    }

    const remainingMs = state.openUntil - now
    const remainingSecs = Math.ceil(remainingMs / 1_000)
    const displayKey = key.length > 64 ? `${key.slice(0, 64)}...` : key
    throw new Error(`Circuit breaker is open for key "${displayKey}" (resets in ${remainingSecs}s).`)
  }

  recordFailure(key: string, options: CacheCircuitBreakerOptions | undefined): void {
    if (!options) {
      return
    }

    const failureThreshold = options.failureThreshold ?? 3
    const cooldownMs = options.cooldownMs ?? 30_000
    const state = this.breakers.get(key) ?? { failures: 0, openUntil: null, createdAt: Date.now() }
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
      this.breakers.delete(key)
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

    const now = Date.now()

    // First pass: remove expired entries (cooldown elapsed)
    for (const [key, state] of this.breakers.entries()) {
      if (this.breakers.size <= this.maxEntries) {
        return
      }
      if (!state.openUntil || state.openUntil <= now) {
        this.breakers.delete(key)
      }
    }

    if (this.breakers.size <= this.maxEntries) {
      return
    }

    // Second pass: remove oldest entries by createdAt (LRU)
    const sorted = [...this.breakers.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt)
    for (const [key] of sorted) {
      if (this.breakers.size <= this.maxEntries) {
        break
      }
      this.breakers.delete(key)
    }
  }
}
