import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// We test the exported `main` function with mocked ioredis
vi.mock('ioredis', () => {
  function makeClient() {
    return {
      connect: async () => undefined,
      scan: async () => ['0', ['key:1', 'key:2']],
      del: async () => 2,
      disconnect: () => undefined,
      smembers: async () => [],
      pipeline: () => ({ exec: async () => [] })
    }
  }
  function Redis() {
    return makeClient()
  }
  return { default: Redis }
})

// Mock RedisTagIndex to avoid complex setup
vi.mock('../src/invalidation/RedisTagIndex', () => ({
  RedisTagIndex: function RedisTagIndex() {
    return {
      keysForTag: async () => ['tag:key:1', 'tag:key:2']
    }
  }
}))

describe('CLI — main()', () => {
  let stdoutOutput: string[]
  let stderrOutput: string[]

  beforeEach(() => {
    stdoutOutput = []
    stderrOutput = []
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdoutOutput.push(String(chunk))
      return true
    })
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderrOutput.push(String(chunk))
      return true
    })
    process.exitCode = undefined
  })

  afterEach(() => {
    vi.restoreAllMocks()
    process.exitCode = undefined
  })

  it('prints usage and sets exitCode=1 when no arguments', async () => {
    const { main } = await import('../src/cli')
    await main([])
    expect(process.exitCode).toBe(1)
    expect(stdoutOutput.join('')).toContain('Usage:')
  })

  it('prints usage and sets exitCode=1 when redis URL is missing', async () => {
    const { main } = await import('../src/cli')
    await main(['stats'])
    expect(process.exitCode).toBe(1)
  })

  it('rejects an invalid redis URL', async () => {
    const { main } = await import('../src/cli')
    await main(['stats', '--redis', 'not-a-url$$'])
    expect(process.exitCode).toBe(1)
    expect(stderrOutput.join('')).toContain('invalid Redis URL')
  })

  it('stats command outputs totalKeys JSON', async () => {
    const { main } = await import('../src/cli')
    await main(['stats', '--redis', 'redis://localhost:6379'])
    const output = stdoutOutput.join('')
    expect(output).toContain('totalKeys')
  })

  it('keys command outputs key list', async () => {
    const { main } = await import('../src/cli')
    await main(['keys', '--redis', 'redis://localhost:6379'])
    const output = stdoutOutput.join('')
    expect(output).toContain('key:1')
  })

  it('invalidate command with pattern outputs deletedKeys', async () => {
    const { main } = await import('../src/cli')
    await main(['invalidate', '--redis', 'redis://localhost:6379', '--pattern', 'key:*'])
    const output = stdoutOutput.join('')
    expect(output).toContain('deletedKeys')
  })

  it('invalidate command with tag outputs deletedKeys', async () => {
    const { main } = await import('../src/cli')
    await main(['invalidate', '--redis', 'redis://localhost:6379', '--tag', 'user:1'])
    const output = stdoutOutput.join('')
    expect(output).toContain('deletedKeys')
    expect(output).toContain('user:1')
  })
})
