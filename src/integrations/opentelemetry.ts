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

/**
 * Lightweight OpenTelemetry instrumentation for a CacheStack instance.
 *
 * This implementation subscribes to CacheStack operation hooks instead of
 * monkey-patching instance methods, so it can coexist with other plugins.
 */
export function createOpenTelemetryPlugin(cache: CacheStack, tracer: OpenTelemetryTracer) {
  const spans = new Map<number, OpenTelemetrySpan>()

  const onStart = (event: CacheOperationStart): void => {
    spans.set(event.id, tracer.startSpan(event.name, { attributes: event.attributes }))
  }

  const onEnd = (event: CacheOperationEnd): void => {
    const span = spans.get(event.id)
    if (!span) {
      return
    }

    spans.delete(event.id)
    span.setAttribute?.('layercache.success', event.success)
    if (event.result) {
      span.setAttribute?.('layercache.result', event.result)
    }
    if (event.error !== undefined) {
      span.recordException?.(event.error)
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
