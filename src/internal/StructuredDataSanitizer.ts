const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor'])

interface SanitizeStructuredDataOptions {
  maxDepth: number
  maxNodes: number
  label: string
  createObject?: () => Record<string, unknown>
}

export function sanitizeStructuredData(value: unknown, options: SanitizeStructuredDataOptions): unknown {
  return sanitizeValue(value, 0, { count: 0 }, options)
}

function sanitizeValue(
  value: unknown,
  depth: number,
  state: { count: number },
  options: SanitizeStructuredDataOptions
): unknown {
  state.count += 1
  if (state.count > options.maxNodes) {
    throw new Error(`${options.label} exceeds max node count of ${options.maxNodes}.`)
  }

  if (depth > options.maxDepth) {
    throw new Error(`${options.label} exceeds max depth of ${options.maxDepth}.`)
  }

  if (Array.isArray(value)) {
    const sanitized: unknown[] = []
    for (const entry of value) {
      sanitized.push(sanitizeValue(entry, depth + 1, state, options))
    }
    return sanitized
  }

  if (!isPlainObject(value)) {
    return value
  }

  const sanitized = (options.createObject?.() ?? {}) as Record<string, unknown>
  for (const [key, entry] of Object.entries(value)) {
    if (DANGEROUS_KEYS.has(key)) {
      continue
    }

    sanitized[key] = sanitizeValue(entry, depth + 1, state, options)
  }

  return sanitized
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Object.prototype.toString.call(value) === '[object Object]'
}
