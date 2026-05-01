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

/**
 * Lightweight OpenTelemetry instrumentation for a CacheStack instance.
 *
 * This implementation subscribes to CacheStack operation hooks instead of
 * monkey-patching instance methods, so it can coexist with other plugins.
 */
export function createOpenTelemetryPlugin(cache: CacheStack, tracer: OpenTelemetryTracer) {
  const spans = new Map<number, OpenTelemetrySpan>()

  const onStart = (event: CacheOperationStart): void => {
    try {
      // Evict stale spans if the map grows too large (orphaned from missing operation-end)
      if (spans.size >= MAX_SPANS) {
        const oldest = spans.keys().next().value
        /* v8 ignore next -- Map has a first key whenever size is at least MAX_SPANS */
        if (oldest !== undefined) {
          spans.get(oldest)?.end()
          spans.delete(oldest)
        }
      }
      spans.set(event.id, tracer.startSpan(event.name, { attributes: event.attributes }))
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
