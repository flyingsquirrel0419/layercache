import { Mutex } from 'async-mutex'

export class StampedeGuard {
  private readonly mutexes = new Map<string, Mutex>()

  async execute<T>(key: string, task: () => Promise<T>): Promise<T> {
    const mutex = this.getMutex(key)

    try {
      return await mutex.runExclusive(task)
    } finally {
      if (!mutex.isLocked()) {
        this.mutexes.delete(key)
      }
    }
  }

  private getMutex(key: string): Mutex {
    let mutex = this.mutexes.get(key)
    if (!mutex) {
      mutex = new Mutex()
      this.mutexes.set(key, mutex)
    }
    return mutex
  }
}
