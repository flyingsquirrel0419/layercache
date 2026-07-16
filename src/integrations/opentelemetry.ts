import { createHash } from 'node:crypto'
import type { CacheStack } from '../CacheStack'
import type { CacheStackEvents } from '../types'

interface OpenTelemetrySpan {
  setAttribute?: (name: string, value: unknown) => void
  recordException?: (error: unknown) => void
  end: () => void
}

interface OpenTelemetryTracer {
  startSpan: (name: string, options?: { attributes?: Record<string, unknown> }) => OpenTelemetrySpan
}

type CacheOperationStart = CacheStackEvents['operation-start']
type CacheOperationEnd = CacheStackEvents['operation-end']

const MAX_SPANS = 10_000
const RAW_KEY_ATTRIBUTE = 'layercache.key'
const KEY_HASH_ATTRIBUTE = 'layercache.key_hash'

interface OpenTelemetryPluginOptions {
  /** Include raw cache keys in span attributes. Disabled by default. */
  includeRawKeyAttributes?: boolean
}

/**
 * Lightweight OpenTelemetry instrumentation for a CacheStack instance.
 *
 * This implementation subscribes to CacheStack operation hooks instead of
 * monkey-patching instance methods, so it can coexist with other plugins.
 */
export function createOpenTelemetryPlugin(
  cache: CacheStack,
  tracer: OpenTelemetryTracer,
  options: OpenTelemetryPluginOptions = {}
) {
  const spans = new Map<number, OpenTelemetrySpan>()

  const onStart = (event: CacheOperationStart): void => {
    try {
      // Evict stale spans if the map grows too large (orphaned from missing operation-end)
      if (spans.size >= MAX_SPANS) {
        const oldest = spans.keys().next().value
        if (oldest !== undefined) {
          spans.get(oldest)?.end()
          spans.delete(oldest)
        }
      }
      spans.set(event.id, tracer.startSpan(event.name, { attributes: sanitizeAttributes(event.attributes, options) }))
    } catch {
      // Swallow tracer errors to avoid breaking cache operations
    }
  }

  const onEnd = (event: CacheOperationEnd): void => {
    const span = spans.get(event.id)
    if (!span) {
      return
    }

    spans.delete(event.id)
    try {
      span.setAttribute?.('layercache.success', event.success)
      if (event.result) {
        span.setAttribute?.('layercache.result', event.result)
      }
      if (event.error !== undefined) {
        span.recordException?.(event.error)
      }
    } catch {
      // Swallow tracer errors to avoid breaking cache operations
    }
    span.end()
  }

  cache.on('operation-start', onStart)
  cache.on('operation-end', onEnd)

  return {
    uninstall(): void {
      cache.off('operation-start', onStart)
      cache.off('operation-end', onEnd)
      for (const span of spans.values()) {
        span.end()
      }
      spans.clear()
    }
  }
}

function sanitizeAttributes(
  attributes: Record<string, unknown> | undefined,
  options: OpenTelemetryPluginOptions
): Record<string, unknown> | undefined {
  if (!attributes || options.includeRawKeyAttributes === true || !(RAW_KEY_ATTRIBUTE in attributes)) {
    return attributes
  }

  const sanitized = { ...attributes }
  const rawKey = sanitized[RAW_KEY_ATTRIBUTE]
  delete sanitized[RAW_KEY_ATTRIBUTE]
  sanitized[KEY_HASH_ATTRIBUTE] = createHash('sha256')
    .update(String(rawKey ?? ''))
    .digest('hex')
  return sanitized
}
