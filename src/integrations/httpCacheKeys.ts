const SENSITIVE_QUERY_PARAMETERS = new Set([
  'access_token',
  'api_key',
  'apikey',
  'auth',
  'authorization',
  'client_assertion',
  'client_assertion_type',
  'client_secret',
  'code',
  'credentials',
  'id_token',
  'jwt',
  'password',
  'private_key',
  'refresh_token',
  'secret',
  'session',
  'sessionid',
  'session_id',
  'token'
])

const SENSITIVE_HEADERS = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-session-id',
  'x-auth-token',
  'x-forwarded-user'
])

export function normalizeHttpCacheUrl(url: string): string {
  return inspectHttpCacheUrl(url).normalizedUrl
}

export function hasSensitiveHttpCacheQuery(url: string): boolean {
  return inspectHttpCacheUrl(url).hasSensitiveQuery
}

/**
 * Checks whether the request carries any authentication-related headers that
 * make the response caller-specific. When these are present, implicit URL-only
 * caching would serve one user's authenticated data to another.
 *
 * Accepts either a headers object (web `Headers`, a plain record, or an object
 * with a `get()`/`header()` accessor) or a request-like object with a nested
 * `headers` field and/or a `get()`/`header()` accessor (Express/Hono style).
 */
export function hasSensitiveHttpCacheHeaders(request: unknown): boolean {
  if (!request || typeof request !== 'object') {
    return false
  }

  const record = request as Record<string, unknown>

  for (const name of SENSITIVE_HEADERS) {
    if (readHeader(record, name)) {
      return true
    }
  }

  const headers = record.headers
  if (headers && typeof headers === 'object') {
    const headerRecord = headers as Record<string, unknown>
    for (const name of SENSITIVE_HEADERS) {
      if (readHeader(headerRecord, name)) {
        return true
      }
    }
  }

  return false
}

/** Reads a single header value from an accessor-bearing or plain-record header object. */
function readHeader(record: Record<string, unknown>, name: string): string | undefined | null {
  if (typeof record.get === 'function' || typeof record.header === 'function') {
    const method = (typeof record.get === 'function' ? record.get : record.header) as (
      this: unknown,
      n: string
    ) => string | undefined | null
    return method.call(record, name)
  }

  // Plain records may use any casing (e.g. `Authorization`); match case-insensitively.
  for (const [key, value] of Object.entries(record)) {
    if (key.toLowerCase() === name && typeof value === 'string' && value !== '') {
      return value
    }
  }

  return undefined
}

function inspectHttpCacheUrl(url: string): { normalizedUrl: string; hasSensitiveQuery: boolean } {
  try {
    const parsed = new URL(url, 'http://localhost')
    let hasSensitiveQuery = false
    for (const name of [...parsed.searchParams.keys()]) {
      if (SENSITIVE_QUERY_PARAMETERS.has(name.toLowerCase())) {
        hasSensitiveQuery = true
        parsed.searchParams.delete(name)
      }
    }
    parsed.searchParams.sort()
    return {
      normalizedUrl: parsed.pathname + parsed.search,
      hasSensitiveQuery
    }
  } catch {
    return {
      normalizedUrl: url,
      hasSensitiveQuery: true
    }
  }
}
