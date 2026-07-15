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

export function normalizeHttpCacheUrl(url: string): string {
  return inspectHttpCacheUrl(url).normalizedUrl
}

export function hasSensitiveHttpCacheQuery(url: string): boolean {
  return inspectHttpCacheUrl(url).hasSensitiveQuery
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
