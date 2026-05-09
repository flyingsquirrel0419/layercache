import type {
  CacheAdaptiveTtlOptions,
  CacheCircuitBreakerOptions,
  CacheEntryWriteOptions,
  CacheRateLimitOptions,
  CacheTtlPolicy,
  LayerTtlMap
} from '../types'

export const MAX_CACHE_KEY_LENGTH = 1_024
export const MAX_PATTERN_LENGTH = 1_024
export const MAX_TAGS_PER_OPERATION = 128

export function validatePositiveNumber(name: string, value: number | undefined): void {
  if (value === undefined) {
    return
  }

  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive finite number.`)
  }
}

export function validateNonNegativeNumber(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative finite number.`)
  }
}

export function validateLayerNumberOption(name: string, value: number | LayerTtlMap | undefined): void {
  if (value === undefined) {
    return
  }

  if (typeof value === 'number') {
    validateNonNegativeNumber(name, value)
    return
  }

  for (const [layerName, layerValue] of Object.entries(value)) {
    if (layerValue === undefined) {
      continue
    }

    validateNonNegativeNumber(`${name}.${layerName}`, layerValue)
  }
}

export function validateRateLimitOptions(name: string, options: CacheRateLimitOptions | undefined): void {
  if (!options) {
    return
  }

  validatePositiveNumber(`${name}.maxConcurrent`, options.maxConcurrent)
  validatePositiveNumber(`${name}.intervalMs`, options.intervalMs)
  validatePositiveNumber(`${name}.maxPerInterval`, options.maxPerInterval)

  if (options.scope && !['global', 'key', 'fetcher'].includes(options.scope)) {
    throw new Error(`${name}.scope must be one of "global", "key", or "fetcher".`)
  }

  if (options.queueOverflow && !['reject', 'bypass'].includes(options.queueOverflow)) {
    throw new Error(`${name}.queueOverflow must be one of "reject" or "bypass".`)
  }

  if (options.bucketKey !== undefined && options.bucketKey.length === 0) {
    throw new Error(`${name}.bucketKey must not be empty.`)
  }
}

export function validateCacheKey(key: string): string {
  if (key.length === 0) {
    throw new Error('Cache key must not be empty.')
  }

  if (key.length > MAX_CACHE_KEY_LENGTH) {
    throw new Error(`Cache key length must be at most ${MAX_CACHE_KEY_LENGTH} characters.`)
  }

  if (/[\u0000-\u001F\u007F]/.test(key)) {
    throw new Error('Cache key contains unsupported control characters.')
  }

  if (/[\uD800-\uDFFF]/.test(key)) {
    throw new Error('Cache key contains unsupported surrogate code points.')
  }

  return key
}

export function validateTag(tag: string): string {
  if (tag.length === 0) {
    throw new Error('Cache tag must not be empty.')
  }

  if (tag.length > MAX_CACHE_KEY_LENGTH) {
    throw new Error(`Cache tag length must be at most ${MAX_CACHE_KEY_LENGTH} characters.`)
  }

  if (/[\u0000-\u001F\u007F]/.test(tag)) {
    throw new Error('Cache tag contains unsupported control characters.')
  }

  if (/[\uD800-\uDFFF]/.test(tag)) {
    throw new Error('Cache tag contains unsupported surrogate code points.')
  }

  return tag
}

export function validateTags(tags: string[] | undefined): void {
  if (!tags) {
    return
  }

  if (tags.length > MAX_TAGS_PER_OPERATION) {
    throw new Error(`options.tags must contain at most ${MAX_TAGS_PER_OPERATION} tags.`)
  }

  for (const tag of tags) {
    validateTag(tag)
  }
}

export function validatePattern(pattern: string): void {
  if (pattern.length === 0) {
    throw new Error('Pattern must not be empty.')
  }

  if (pattern.length > MAX_PATTERN_LENGTH) {
    throw new Error(`Pattern length must be at most ${MAX_PATTERN_LENGTH} characters.`)
  }

  if (/[\u0000-\u001F\u007F]/.test(pattern)) {
    throw new Error('Pattern contains unsupported control characters.')
  }
}

export function validateTtlPolicy(name: string, policy: CacheTtlPolicy | undefined): void {
  if (!policy || typeof policy === 'function' || policy === 'until-midnight' || policy === 'next-hour') {
    return
  }

  if ('alignTo' in policy) {
    validatePositiveNumber(`${name}.alignTo`, policy.alignTo)
    return
  }

  throw new Error(`${name} is invalid.`)
}

export function validateAdaptiveTtlOptions(options: boolean | CacheAdaptiveTtlOptions | undefined): void {
  if (!options || options === true) {
    return
  }

  validatePositiveNumber('adaptiveTtl.hotAfter', options.hotAfter)
  validateLayerNumberOption('adaptiveTtl.step', options.step)
  validateLayerNumberOption('adaptiveTtl.maxTtl', options.maxTtl)
}

export function validateCircuitBreakerOptions(options: CacheCircuitBreakerOptions | undefined): void {
  if (!options) {
    return
  }

  validatePositiveNumber('circuitBreaker.failureThreshold', options.failureThreshold)
  validatePositiveNumber('circuitBreaker.cooldownMs', options.cooldownMs)

  if (options.scope && !['key', 'shared'].includes(options.scope)) {
    throw new Error('circuitBreaker.scope must be one of "key" or "shared".')
  }

  if (options.breakerKey !== undefined && options.breakerKey.length === 0) {
    throw new Error('circuitBreaker.breakerKey must not be empty.')
  }
}

export function validateContextEntryOptions(name: string, options: CacheEntryWriteOptions | undefined): void {
  if (!options) {
    return
  }

  validateLayerNumberOption(`${name}.ttl`, options.ttl)
  validateLayerNumberOption(`${name}.negativeTtl`, options.negativeTtl)
  validateLayerNumberOption(`${name}.staleWhileRevalidate`, options.staleWhileRevalidate)
  validateLayerNumberOption(`${name}.staleIfError`, options.staleIfError)
  validateLayerNumberOption(`${name}.ttlJitter`, options.ttlJitter)
  validateTtlPolicy(`${name}.ttlPolicy`, options.ttlPolicy)
  validateAdaptiveTtlOptions(options.adaptiveTtl)
  validateTags(options.tags)
}
