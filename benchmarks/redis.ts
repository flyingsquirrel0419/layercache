import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { Redis } from 'ioredis'

const execFileAsync = promisify(execFile)

export const REDIS_CONTAINER_NAME = 'layercache-bench-redis'
export const REDIS_PORT = 6390
export const REDIS_IMAGE = 'redis:7-alpine'

async function docker(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('docker', args, {
    cwd: process.cwd(),
    maxBuffer: 10 * 1024 * 1024
  })

  return stdout.trim()
}

async function containerExists(): Promise<boolean> {
  try {
    await docker(['inspect', REDIS_CONTAINER_NAME])
    return true
  } catch {
    return false
  }
}

async function isContainerRunning(): Promise<boolean> {
  try {
    return (await docker(['inspect', '-f', '{{.State.Running}}', REDIS_CONTAINER_NAME])) === 'true'
  } catch {
    return false
  }
}

async function isContainerPaused(): Promise<boolean> {
  try {
    return (await docker(['inspect', '-f', '{{.State.Paused}}', REDIS_CONTAINER_NAME])) === 'true'
  } catch {
    return false
  }
}

export async function ensureRedisContainer(): Promise<void> {
  await docker(['version', '--format', '{{.Server.Version}}'])

  if (await isContainerRunning()) {
    return
  }

  if (await containerExists()) {
    await docker(['start', REDIS_CONTAINER_NAME])
    return
  }

  await docker(['run', '-d', '--rm', '--name', REDIS_CONTAINER_NAME, '-p', `${REDIS_PORT}:6379`, REDIS_IMAGE])
}

export async function stopRedisContainer(): Promise<void> {
  try {
    await docker(['rm', '-f', REDIS_CONTAINER_NAME])
  } catch {
    // Ignore cleanup failures so benchmark reporting can continue.
  }
}

export async function pauseRedisContainer(): Promise<void> {
  if (await isContainerPaused()) {
    return
  }

  await docker(['pause', REDIS_CONTAINER_NAME])
}

export async function unpauseRedisContainer(): Promise<void> {
  if (!(await isContainerPaused())) {
    return
  }

  await docker(['unpause', REDIS_CONTAINER_NAME])
}

export function createRedisClient(port = REDIS_PORT): Redis {
  return new Redis(`redis://127.0.0.1:${port}`, {
    maxRetriesPerRequest: null
  })
}

export async function waitForRedisReady(retries = 40): Promise<void> {
  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      const response = await docker(['exec', REDIS_CONTAINER_NAME, 'redis-cli', 'ping'])
      if (response === 'PONG') {
        return
      }
    } catch {
      // Allow Redis a short time to start up after the container launches.
    }

    await new Promise((resolve) => {
      setTimeout(resolve, 250)
    })
  }

  throw new Error('Redis did not become ready in time')
}
