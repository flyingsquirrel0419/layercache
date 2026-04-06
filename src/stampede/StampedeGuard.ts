import { Mutex } from 'async-mutex'

interface MutexEntry {
  mutex: Mutex
  references: number
}

export class StampedeGuard {
  private readonly mutexes = new Map<string, MutexEntry>()

  async execute<T>(key: string, task: () => Promise<T>): Promise<T> {
    const entry = this.getMutexEntry(key)

    try {
      return await entry.mutex.runExclusive(task)
    } finally {
      entry.references -= 1
      // Re-read from the map to ensure we're operating on the current entry,
      // not a stale reference that may have been replaced under concurrency.
      const current = this.mutexes.get(key)
      if (current === entry && entry.references === 0 && !entry.mutex.isLocked()) {
        this.mutexes.delete(key)
      }
    }
  }

  private getMutexEntry(key: string): MutexEntry {
    let entry = this.mutexes.get(key)
    if (!entry) {
      entry = { mutex: new Mutex(), references: 0 }
      this.mutexes.set(key, entry)
    }

    entry.references += 1
    return entry
  }
}
