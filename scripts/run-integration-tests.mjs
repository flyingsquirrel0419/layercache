import { spawn } from 'node:child_process'
import net from 'node:net'

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379'
const dockerBin = process.platform === 'win32' ? 'docker.exe' : 'docker'
const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm'

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: 'inherit',
      shell: false,
      ...options
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

async function waitForRedis(timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  const url = new URL(REDIS_URL)
  const host = url.hostname || '127.0.0.1'
  const port = Number(url.port || 6379)

  while (Date.now() < deadline) {
    try {
      await new Promise((resolve, reject) => {
        const socket = net.connect({ host, port })
        socket.once('connect', () => {
          socket.end()
          resolve(undefined)
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

let exitCode = 0

try {
  const upCode = await run(dockerBin, ['compose', 'up', '-d', 'redis'])
  if (upCode !== 0) {
    exitCode = upCode
  } else {
    await waitForRedis()
    exitCode = await run(npmBin, ['exec', 'vitest', 'run', '--config', 'vitest.integration.config.ts'])
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  exitCode = 1
} finally {
  const downCode = await run(dockerBin, ['compose', 'down']).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    return 1
  })
  if (exitCode === 0 && downCode !== 0) {
    exitCode = downCode
  }
}

process.exit(exitCode)
