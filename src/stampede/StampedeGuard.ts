interface InFlightEntry<T = unknown> {
  promise: Promise<T>
  references: number
  settled: boolean
  timedOut: boolean
}

interface StampedeGuardOptions {
  /**
   * Maximum number of concurrent in-flight keys. When exceeded, new `execute`
   * calls for keys that are not already in-flight will throw immediately.
   * Defaults to 10 000.
   */
  maxInFlight?: number
  /**
   * Maximum milliseconds each caller waits for a single in-flight task before
   * rejecting with a timeout error. Timed-out tasks remain counted against
   * maxInFlight until they settle, while same-key retries may start when capacity
   * remains. Defaults to no timeout.
   */
  entryTimeoutMs?: number
  /** Called once when an underlying task first exceeds entryTimeoutMs. */
  onEntryTimeout?: (key: string) => void
}

export class StampedeGuard {
  private readonly inFlight = new Map<string, InFlightEntry>()
  private readonly maxInFlight: number
  private readonly entryTimeoutMs: number | undefined
  private readonly onEntryTimeout: ((key: string) => void) | undefined
  private activeTasks = 0

  constructor(options: StampedeGuardOptions = {}) {
    this.maxInFlight = options.maxInFlight ?? 10_000
    this.entryTimeoutMs = options.entryTimeoutMs
    this.onEntryTimeout = options.onEntryTimeout
  }

  /**
   * Deduplicates concurrent work for the same key in this process.
   */
  async execute<T>(key: string, task: () => Promise<T>): Promise<T> {
    const existing = this.inFlight.get(key) as InFlightEntry<T> | undefined
    if (existing) {
      existing.references += 1
      try {
        return await this.waitForEntry(key, existing, existing.promise)
      } finally {
        this.releaseEntry(key, existing)
      }
    }

    if (this.activeTasks >= this.maxInFlight) {
      throw new Error(
        `StampedeGuard: in-flight limit of ${this.maxInFlight} exceeded. Rejecting new key to prevent memory exhaustion.`
      )
    }

    const taskPromise = Promise.resolve().then(task)
    const entry: InFlightEntry<T> = {
      promise: taskPromise,
      references: 1,
      settled: false,
      timedOut: false
    }
    this.activeTasks += 1
    this.inFlight.set(key, entry)
    void taskPromise.then(
      () => this.settleEntry(key, entry),
      () => this.settleEntry(key, entry)
    )

    try {
      return await this.waitForEntry(key, entry, entry.promise)
    } finally {
      this.releaseEntry(key, entry)
    }
  }

  /** Detaches a timed-out key so a safe, generation-fenced retry can start. */
  releaseTimedOut(key: string): void {
    const entry = this.inFlight.get(key)
    if (!entry || entry.timedOut) return
    entry.timedOut = true
    this.inFlight.delete(key)
    this.onEntryTimeout?.(key)
  }

  private waitForEntry<T>(key: string, entry: InFlightEntry<T>, promise: Promise<T>): Promise<T> {
    return this.entryTimeoutMs ? this.withTimeout(key, entry, promise, this.entryTimeoutMs) : promise
  }

  private withTimeout<T>(key: string, entry: InFlightEntry<T>, promise: Promise<T>, timeoutMs: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.inFlight.get(key) === entry) this.releaseTimedOut(key)
        reject(
          new Error(
            `StampedeGuard: task for key "${key.slice(0, 64)}${key.length > 64 ? '...' : ''}" timed out after ${timeoutMs}ms.`
          )
        )
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
    if (current === entry && entry.references === 0 && entry.settled) {
      this.inFlight.delete(key)
    }
  }

  private settleEntry(key: string, entry: InFlightEntry): void {
    entry.settled = true
    this.activeTasks -= 1
    if (entry.references === 0 && this.inFlight.get(key) === entry) {
      this.inFlight.delete(key)
    }
  }
}
