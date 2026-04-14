import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

async function runTsx(scriptName: string): Promise<string> {
  const tsxPath = join(process.cwd(), 'node_modules', '.bin', 'tsx')
  const scriptPath = join(process.cwd(), 'benchmarks', scriptName)
  const { stdout } = await execFileAsync(tsxPath, [scriptPath], {
    cwd: process.cwd(),
    maxBuffer: 50 * 1024 * 1024
  })

  return stdout.trim()
}

function extractJsonBlock(output: string): unknown {
  const lines = output.trim().split('\n')
  const startIndex = lines.findIndex((line) => line.startsWith('{'))
  if (startIndex === -1) {
    throw new Error('Benchmark output did not contain a JSON block')
  }

  return JSON.parse(lines.slice(startIndex).join('\n'))
}

async function main(): Promise<void> {
  const slowRedisOutput = await runTsx('slow-redis-latency.ts')
  process.stdout.write(`${slowRedisOutput}\n`)

  const memoryPressureOutput = await runTsx('memory-pressure.ts')
  process.stdout.write(`${memoryPressureOutput}\n`)

  const combined = {
    type: 'slow-redis-memory-pressure-benchmark',
    slowRedis: extractJsonBlock(slowRedisOutput),
    memoryPressure: extractJsonBlock(memoryPressureOutput)
  }

  console.log(JSON.stringify(combined, null, 2))
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
