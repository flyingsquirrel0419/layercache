import type { CacheSerializer } from '../types'

export class JsonSerializer implements CacheSerializer {
  serialize(value: unknown): string {
    return JSON.stringify(value)
  }

  deserialize<T>(payload: string | Buffer): T {
    const normalized = Buffer.isBuffer(payload) ? payload.toString('utf8') : payload
    return JSON.parse(normalized) as T
  }
}
