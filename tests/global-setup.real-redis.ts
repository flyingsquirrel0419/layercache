import { spawn } from 'node:child_process'
import net from 'node:net'
import type { TestProject } from 'vitest/node'
import { DEFAULT_REDIS_PORT, prepareRedisUrl } from './helpers/redis-config'

const dockerBin = process.platform === 'win32' ? 'docker.exe' : 'docker'
const useExistingRedis = process.env.REDIS_AVAILABLE === '1'

function run(command: string, args: string[], environment?: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: 'inherit',
      shell: false,
      env: { ...process.env, ...environment }
    })

    child.on('error', reject)
    child.on('exit', (code, signal) => {
      if (signal) {
        reject(new Error(`${command} ${args.join(' ')} exited with signal ${signal}`))
        return
      }
      resolve(code ?? 0)
    })
  })
}

async function waitForRedis(redisUrl: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  const url = redisUrl.includes('://') ? new URL(redisUrl) : new URL(`redis://${redisUrl}`)
  const host = url.hostname || '127.0.0.1'
  const port = Number(url.port || 6379)

  while (Date.now() < deadline) {
    try {
      await new Promise<void>((resolve, reject) => {
        const socket = net.connect({ host, port })
        socket.once('connect', () => {
          socket.end()
          resolve()
        })
        socket.once('error', reject)
      })
      return
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
  }

  throw new Error(`Redis did not become ready at ${redisUrl} within ${timeoutMs}ms`)
}

async function composeDown(projectName: string): Promise<void> {
  const downCode = await run(dockerBin, ['compose', '--project-name', projectName, 'down'])
  if (downCode !== 0) {
    throw new Error(`docker compose down failed with exit code ${downCode}`)
  }
}

export async function setup({ provide }: TestProject): Promise<(() => Promise<void>) | undefined> {
  if (useExistingRedis) {
    const redisUrl = process.env.REDIS_URL ?? `redis://localhost:${DEFAULT_REDIS_PORT}`
    provide('redisUrl', redisUrl)
    await waitForRedis(redisUrl)
    return
  }

  const redisUrl = process.env.REDIS_URL ?? (await prepareRedisUrl())
  provide('redisUrl', redisUrl)
  const redisPort = new URL(redisUrl.includes('://') ? redisUrl : `redis://${redisUrl}`).port || '6379'
  const projectName = `layercache-test-${redisPort}`
  const upCode = await run(dockerBin, ['compose', '--project-name', projectName, 'up', '-d', 'redis'], {
    REDIS_PORT: redisPort
  })
  if (upCode !== 0) {
    throw new Error(`docker compose up failed with exit code ${upCode}`)
  }

  try {
    await waitForRedis(redisUrl)
  } catch (error) {
    await composeDown(projectName).catch(() => undefined)
    throw error
  }

  return () => composeDown(projectName)
}
