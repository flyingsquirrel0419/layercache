import { displayKey } from '../internal/KeyDisplay'

interface InFlightEntry<T = unknown> {
  promise: Promise<T>
  references: number
}

interface StampedeGuardOptions {
  /**
   * Maximum number of concurrent in-flight keys. When exceeded, new `execute`
   * calls for keys that are not already in-flight will throw immediately.
   * Defaults to 10 000.
   */
  maxInFlight?: number
  /**
   * Maximum milliseconds to wait for a single in-flight task before rejecting
   * with a timeout error. When a timeout fires the entry is released so
   * subsequent callers can retry. Defaults to no timeout.
   */
  entryTimeoutMs?: number
}

export class StampedeGuard {
  private readonly inFlight = new Map<string, InFlightEntry>()
  private readonly maxInFlight: number
  private readonly entryTimeoutMs: number | undefined

  constructor(options: StampedeGuardOptions = {}) {
    this.maxInFlight = options.maxInFlight ?? 10_000
    this.entryTimeoutMs = options.entryTimeoutMs
  }

  async execute<T>(key: string, task: () => Promise<T>): Promise<T> {
    const existing = this.inFlight.get(key) as InFlightEntry<T> | undefined
    if (existing) {
      existing.references += 1
      try {
        return await existing.promise
      } finally {
        this.releaseEntry(key, existing)
      }
    }

    if (this.inFlight.size >= this.maxInFlight) {
      throw new Error(
        `StampedeGuard: in-flight limit of ${this.maxInFlight} exceeded. Rejecting new key to prevent memory exhaustion.`
      )
    }

    const taskPromise = Promise.resolve().then(task)
    const guardedPromise = this.entryTimeoutMs ? this.withTimeout(key, taskPromise, this.entryTimeoutMs) : taskPromise

    const entry: InFlightEntry<T> = {
      promise: guardedPromise,
      references: 1
    }
    this.inFlight.set(key, entry)

    try {
      return await entry.promise
    } finally {
      this.releaseEntry(key, entry)
    }
  }

  private withTimeout<T>(key: string, promise: Promise<T>, timeoutMs: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`StampedeGuard: task for key "${displayKey(key)}" timed out after ${timeoutMs}ms.`))
      }, timeoutMs)

      promise.then(
        (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        (error: unknown) => {
          clearTimeout(timer)
          reject(error)
        }
      )
    })
  }

  private releaseEntry(key: string, entry: InFlightEntry): void {
    entry.references -= 1
    const current = this.inFlight.get(key)
    if (current === entry && entry.references === 0) {
      this.inFlight.delete(key)
    }
  }
}
