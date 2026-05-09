import { describe, expect, it } from 'vitest'
import {
  MAX_CACHE_KEY_LENGTH,
  MAX_PATTERN_LENGTH,
  validateAdaptiveTtlOptions,
  validateCacheKey,
  validateCircuitBreakerOptions,
  validateContextEntryOptions,
  validateLayerNumberOption,
  validateNonNegativeNumber,
  validatePattern,
  validatePositiveNumber,
  validateRateLimitOptions,
  validateTag,
  validateTags,
  validateTtlPolicy
} from '../../src/internal/CacheStackValidation'

describe('CacheStackValidation', () => {
  it('validates numbers and layer number options', () => {
    expect(() => validatePositiveNumber('x', 1)).not.toThrow()
    expect(() => validatePositiveNumber('x', undefined)).not.toThrow()
    expect(() => validatePositiveNumber('x', 0)).toThrow(/positive finite number/i)
    expect(() => validateNonNegativeNumber('x', 0)).not.toThrow()
    expect(() => validateNonNegativeNumber('x', -1)).toThrow(/non-negative finite number/i)

    expect(() => validateLayerNumberOption('ttl', 5)).not.toThrow()
    expect(() => validateLayerNumberOption('ttl', { memory: 5, redis: undefined })).not.toThrow()
    expect(() => validateLayerNumberOption('ttl', { memory: -1 })).toThrow(/non-negative finite number/i)
  })

  it('validates keys tags and patterns', () => {
    expect(validateCacheKey('user:1')).toBe('user:1')
    expect(() => validateCacheKey('')).toThrow(/must not be empty/i)
    expect(() => validateCacheKey(`a${'\u0000'}b`)).toThrow(/control characters/i)
    expect(() => validateCacheKey(`a${'\uD800'}b`)).toThrow(/surrogate/i)
    expect(() => validateCacheKey('x'.repeat(MAX_CACHE_KEY_LENGTH + 1))).toThrow(/at most 1024/i)

    expect(validateTag('users')).toBe('users')
    expect(() => validateTag('')).toThrow(/must not be empty/i)
    expect(() => validateTag(`a${'\u0000'}b`)).toThrow(/control characters/i)
    expect(() => validateTag(`a${'\uD800'}b`)).toThrow(/surrogate/i)
    expect(() => validateTag('x'.repeat(MAX_CACHE_KEY_LENGTH + 1))).toThrow(/at most 1024/i)
    expect(() => validateTags(Array.from({ length: 129 }, (_, index) => `tag:${index}`))).toThrow(/at most 128/i)
    expect(() => validateTags(['a', 'b'])).not.toThrow()

    expect(() => validatePattern('user:*')).not.toThrow()
    expect(() => validatePattern('')).toThrow(/must not be empty/i)
    expect(() => validatePattern(`a${'\u0000'}b`)).toThrow(/control characters/i)
    expect(() => validatePattern('x'.repeat(MAX_PATTERN_LENGTH + 1))).toThrow(/at most 1024/i)
  })

  it('validates ttl and circuit breaker related options', () => {
    expect(() => validateTtlPolicy('ttlPolicy', undefined)).not.toThrow()
    expect(() => validateTtlPolicy('ttlPolicy', 'until-midnight')).not.toThrow()
    expect(() => validateTtlPolicy('ttlPolicy', { alignTo: 60 })).not.toThrow()
    expect(() => validateTtlPolicy('ttlPolicy', { alignTo: 0 })).toThrow(/positive finite number/i)
    expect(() => validateTtlPolicy('ttlPolicy', {} as never)).toThrow(/invalid/i)

    expect(() => validateAdaptiveTtlOptions(undefined)).not.toThrow()
    expect(() => validateAdaptiveTtlOptions(true)).not.toThrow()
    expect(() => validateAdaptiveTtlOptions({ hotAfter: 2, step: { memory: 1 }, maxTtl: 10 })).not.toThrow()
    expect(() => validateAdaptiveTtlOptions({ hotAfter: 0 })).toThrow(/positive finite number/i)
    expect(() => validateContextEntryOptions('contextOptions', undefined)).not.toThrow()
    expect(() => validateContextEntryOptions('contextOptions', { ttl: 10, tags: ['users'] })).not.toThrow()
    expect(() => validateContextEntryOptions('contextOptions', { ttl: -1 })).toThrow(/non-negative finite number/i)

    expect(() => validateCircuitBreakerOptions(undefined)).not.toThrow()
    expect(() =>
      validateCircuitBreakerOptions({ failureThreshold: 1, cooldownMs: 100, scope: 'shared', breakerKey: 'redis' })
    ).not.toThrow()
    expect(() => validateCircuitBreakerOptions({ failureThreshold: 0 })).toThrow(/positive finite number/i)
    expect(() => validateCircuitBreakerOptions({ scope: 'backend' as never })).toThrow(/must be one of/i)
    expect(() => validateCircuitBreakerOptions({ scope: '' as never })).toThrow(/must be one of/i)
    expect(() => validateCircuitBreakerOptions({ breakerKey: '' })).toThrow(/must not be empty/i)
  })

  it('validates rate limit options', () => {
    expect(() => validateRateLimitOptions('rate', undefined)).not.toThrow()
    expect(() =>
      validateRateLimitOptions('rate', { maxConcurrent: 1, intervalMs: 10, maxPerInterval: 2, scope: 'fetcher' })
    ).not.toThrow()
    expect(() => validateRateLimitOptions('rate', { scope: 'tenant' as never })).toThrow(/must be one of/i)
    expect(() => validateRateLimitOptions('rate', { scope: '' as never })).toThrow(/must be one of/i)
    expect(() => validateRateLimitOptions('rate', { queueOverflow: 'drop' as never })).toThrow(/must be one of/i)
    expect(() => validateRateLimitOptions('rate', { queueOverflow: '' as never })).toThrow(/must be one of/i)
    expect(() => validateRateLimitOptions('rate', { bucketKey: '' })).toThrow(/must not be empty/i)
    expect(() => validateRateLimitOptions('rate', { maxConcurrent: 0 })).toThrow(/positive finite number/i)
  })
})
