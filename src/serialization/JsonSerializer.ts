import { sanitizeStructuredData } from '../internal/StructuredDataSanitizer'
import type { CacheSerializer } from '../types'

export class JsonSerializer implements CacheSerializer {
  serialize(value: unknown): string {
    return JSON.stringify(value)
  }

  deserialize<T>(payload: string | Buffer): T {
    const normalized = Buffer.isBuffer(payload) ? payload.toString('utf8') : payload
    let parsed: unknown
    try {
      parsed = JSON.parse(normalized)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`JsonSerializer: failed to parse JSON payload: ${message}`)
    }
    return sanitizeStructuredData(parsed, {
      label: 'JSON payload',
      maxDepth: 200,
      maxNodes: 10_000
    }) as T
  }
}
