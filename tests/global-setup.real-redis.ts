import { spawn } from 'node:child_process'
import net from 'node:net'

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379'
const dockerBin = process.platform === 'win32' ? 'docker.exe' : 'docker'
const useExistingRedis = process.env.REDIS_AVAILABLE === '1'

function run(command: string, args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: 'inherit',
      shell: false
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

async function waitForRedis(timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  const url = REDIS_URL.includes('://') ? new URL(REDIS_URL) : new URL(`redis://${REDIS_URL}`)
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

  throw new Error(`Redis did not become ready at ${REDIS_URL} within ${timeoutMs}ms`)
}

async function composeDown(): Promise<void> {
  const downCode = await run(dockerBin, ['compose', 'down'])
  if (downCode !== 0) {
    throw new Error(`docker compose down failed with exit code ${downCode}`)
  }
}

export async function setup(): Promise<(() => Promise<void>) | undefined> {
  if (useExistingRedis) {
    await waitForRedis()
    return
  }

  const upCode = await run(dockerBin, ['compose', 'up', '-d', 'redis'])
  if (upCode !== 0) {
    throw new Error(`docker compose up failed with exit code ${upCode}`)
  }

  try {
    await waitForRedis()
  } catch (error) {
    await composeDown().catch(() => undefined)
    throw error
  }

  return composeDown
}
