import { sanitizeStructuredData } from '../internal/StructuredDataSanitizer'
import type { CacheSerializer } from '../types'

const DEFAULT_MAX_BYTES = 4 * 1_024 * 1_024

export interface JsonSerializerOptions {
  maxBytes?: number
  maxDepth?: number
  maxNodes?: number
}

export class JsonSerializer implements CacheSerializer {
  private readonly maxBytes: number
  private readonly maxDepth: number
  private readonly maxNodes: number

  constructor(options: JsonSerializerOptions = {}) {
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
    this.maxDepth = options.maxDepth ?? 200
    this.maxNodes = options.maxNodes ?? 10_000
  }
  /**
   * Serializes a value to JSON.
   */
  serialize(value: unknown): string {
    return JSON.stringify(value)
  }

  /**
   * Parses JSON and sanitizes the result before returning it.
   */
  deserialize<T>(payload: string | Buffer): T {
    const payloadBytes = typeof payload === 'string' ? new TextEncoder().encode(payload).byteLength : payload.byteLength
    if (payloadBytes > this.maxBytes) {
      throw new Error(`JsonSerializer: payload size ${payloadBytes} exceeds maxBytes ${this.maxBytes}.`)
    }
    const normalized = typeof payload === 'string' ? payload : payload.toString('utf8')
    let parsed: unknown
    try {
      parsed = JSON.parse(normalized)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`JsonSerializer: failed to parse JSON payload: ${message}`)
    }
    return sanitizeStructuredData(parsed, {
      label: 'JSON payload',
      maxDepth: this.maxDepth,
      maxNodes: this.maxNodes
    }) as T
  }
}
