import getPort from 'get-port'

export const DEFAULT_REDIS_PORT = 6379

async function getAvailablePort(): Promise<number> {
  if (process.env.CI) {
    return DEFAULT_REDIS_PORT
  }

  try {
    return await getPort({ port: DEFAULT_REDIS_PORT })
  } catch {
    return DEFAULT_REDIS_PORT
  }
}

export async function prepareRedisUrl(): Promise<string> {
  const port = await getAvailablePort()
  return `redis://localhost:${port}`
}
