const SENSITIVE_QUERY_PARAMETERS = new Set([
  'access_token',
  'api_key',
  'apikey',
  'auth',
  'authorization',
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
  try {
    const parsed = new URL(url, 'http://localhost')
    for (const name of [...parsed.searchParams.keys()]) {
      if (SENSITIVE_QUERY_PARAMETERS.has(name.toLowerCase())) {
        parsed.searchParams.delete(name)
      }
    }
    parsed.searchParams.sort()
    return parsed.pathname + parsed.search
  } catch {
    return url
  }
}
