interface InFlightEntry<T = unknown> {
  promise: Promise<T>
  references: number
}

export class StampedeGuard {
  private readonly inFlight = new Map<string, InFlightEntry>()

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

    const entry: InFlightEntry<T> = {
      promise: Promise.resolve().then(task),
      references: 1
    }
    this.inFlight.set(key, entry)

    try {
      return await entry.promise
    } finally {
      this.releaseEntry(key, entry)
    }
  }

  private releaseEntry(key: string, entry: InFlightEntry): void {
    entry.references -= 1
    const current = this.inFlight.get(key)
    if (current === entry && entry.references === 0) {
      this.inFlight.delete(key)
    }
  }
}
