import type { CacheStack } from '../CacheStack'

interface OpenTelemetrySpan {
  setAttribute?: (name: string, value: unknown) => void
  recordException?: (error: unknown) => void
  end: () => void
}

interface OpenTelemetryTracer {
  startSpan: (name: string, options?: { attributes?: Record<string, unknown> }) => OpenTelemetrySpan
}

type AsyncMethod<TArgs extends unknown[], TResult> = (...args: TArgs) => Promise<TResult>

/**
 * Lightweight OpenTelemetry instrumentation for a CacheStack instance.
 *
 * Note: this implementation wraps instance methods directly. Avoid stacking
 * multiple OpenTelemetry plugins on the same CacheStack at the same time,
 * because each plugin replaces and later restores those methods.
 */
export function createOpenTelemetryPlugin(cache: CacheStack, tracer: OpenTelemetryTracer) {
  const originals = {
    get: cache.get.bind(cache),
    set: cache.set.bind(cache),
    delete: cache.delete.bind(cache),
    mget: cache.mget.bind(cache),
    mset: cache.mset.bind(cache),
    invalidateByTag: cache.invalidateByTag.bind(cache),
    invalidateByTags: cache.invalidateByTags.bind(cache),
    invalidateByPattern: cache.invalidateByPattern.bind(cache),
    invalidateByPrefix: cache.invalidateByPrefix.bind(cache)
  }

  cache.get = instrument('layercache.get', tracer, originals.get, (args) => ({
    'layercache.key': String(args[0] ?? '')
  }))
  cache.set = instrument('layercache.set', tracer, originals.set, (args) => ({
    'layercache.key': String(args[0] ?? '')
  }))
  cache.delete = instrument('layercache.delete', tracer, originals.delete, (args) => ({
    'layercache.key': String(args[0] ?? '')
  }))
  cache.mget = instrument('layercache.mget', tracer, originals.mget)
  cache.mset = instrument('layercache.mset', tracer, originals.mset)
  cache.invalidateByTag = instrument('layercache.invalidate_by_tag', tracer, originals.invalidateByTag)
  cache.invalidateByTags = instrument('layercache.invalidate_by_tags', tracer, originals.invalidateByTags)
  cache.invalidateByPattern = instrument('layercache.invalidate_by_pattern', tracer, originals.invalidateByPattern)
  cache.invalidateByPrefix = instrument('layercache.invalidate_by_prefix', tracer, originals.invalidateByPrefix)

  return {
    uninstall(): void {
      cache.get = originals.get
      cache.set = originals.set
      cache.delete = originals.delete
      cache.mget = originals.mget
      cache.mset = originals.mset
      cache.invalidateByTag = originals.invalidateByTag
      cache.invalidateByTags = originals.invalidateByTags
      cache.invalidateByPattern = originals.invalidateByPattern
      cache.invalidateByPrefix = originals.invalidateByPrefix
    }
  }
}

function instrument<TArgs extends unknown[], TResult>(
  name: string,
  tracer: OpenTelemetryTracer,
  method: AsyncMethod<TArgs, TResult>,
  attributes?: (args: TArgs) => Record<string, unknown>
): AsyncMethod<TArgs, TResult> {
  return (async (...args: TArgs) => {
    const span = tracer.startSpan(name, { attributes: attributes?.(args) })
    try {
      const result = await method(...args)
      span.setAttribute?.('layercache.success', true)
      if (result === null) {
        span.setAttribute?.('layercache.result', 'null')
      }
      return result
    } catch (error) {
      span.setAttribute?.('layercache.success', false)
      span.recordException?.(error)
      throw error
    } finally {
      span.end()
    }
  }) as AsyncMethod<TArgs, TResult>
}
