import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// We test the exported `main` function with mocked ioredis
let connectImpl = async () => undefined
let scanImpl = async () => ['0', ['key:1', 'key:2']] as [string, string[]]
let connectCalls = 0
let delCalls: string[][] = []
let migrateCalls = 0
let tagIndexOptions: unknown[] = []

vi.mock('ioredis', () => {
  function makeClient() {
    return {
      connect: async () => {
        connectCalls += 1
        return connectImpl()
      },
      scan: async () => scanImpl(),
      del: async (...keys: string[]) => {
        delCalls.push(keys)
        return keys.length
      },
      getBuffer: async () => Buffer.from(JSON.stringify({ ok: true })),
      ttl: async () => 42,
      pttl: async () => 42,
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
  RedisTagIndex: function RedisTagIndex(options: unknown) {
    tagIndexOptions.push(options)
    return {
      keysForTag: async () => ['tag:key:1', 'tag:key:2'],
      migrateLegacyKnownKeys: async () => {
        migrateCalls += 1
        return { migratedKeys: 2 }
      }
    }
  }
}))

describe('CLI — main()', () => {
  let stdoutOutput: string[]
  let stderrOutput: string[]
  let originalNodeEnv: string | undefined

  beforeEach(() => {
    connectImpl = async () => undefined
    scanImpl = async () => ['0', ['key:1', 'key:2']]
    connectCalls = 0
    delCalls = []
    migrateCalls = 0
    tagIndexOptions = []
    originalNodeEnv = process.env.NODE_ENV
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
    process.env.NODE_ENV = originalNodeEnv
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

  it('requires --force for explicit broad invalidate patterns', async () => {
    const { main } = await import('../src/cli')
    await main(['invalidate', '--redis', 'redis://localhost:6379', '--pattern', '*'])

    expect(stderrOutput.join('')).toContain('Use --force')
    expect(stdoutOutput.join('')).toBe('')
    expect(delCalls).toEqual([])
  })

  it('allows explicit broad invalidate patterns when --force is provided', async () => {
    const { main } = await import('../src/cli')
    await main(['invalidate', '--redis', 'redis://localhost:6379', '--pattern', '*', '--force'])

    expect(stdoutOutput.join('')).toContain('deletedKeys')
    expect(delCalls).toEqual([['key:1', 'key:2']])
  })

  it('invalidate command with tag outputs deletedKeys', async () => {
    const { main } = await import('../src/cli')
    await main(['invalidate', '--redis', 'redis://localhost:6379', '--tag', 'user:1'])
    const output = stdoutOutput.join('')
    expect(output).toContain('deletedKeys')
    expect(output).toContain('user:1')
  })

  it('inspect command outputs key metadata', async () => {
    const { main } = await import('../src/cli')
    await main(['inspect', '--redis', 'redis://localhost:6379', '--key', 'user:1'])
    const output = stdoutOutput.join('')
    expect(output).toContain('"key": "user:1"')
    expect(output).toContain('"ttlMs": 42')
  })

  it('masks Redis credentials in connection failures', async () => {
    connectImpl = async () => {
      throw new Error('auth failed')
    }

    const { main } = await import('../src/cli')
    await main(['stats', '--redis', 'redis://default:secret@localhost:6379'])

    expect(stderrOutput.join('')).toContain('redis://default:***@localhost:6379')
    expect(stderrOutput.join('')).not.toContain('secret')
  })

  it('masks Redis credentials embedded in nested connection error messages', async () => {
    connectImpl = async () => {
      throw new Error('failed for redis://default:secret@localhost:6379/0')
    }

    const { main } = await import('../src/cli')
    await main(['stats', '--redis', 'redis://default:secret@localhost:6379/0'])

    expect(stderrOutput.join('')).toContain('redis://default:***@localhost:6379/0')
    expect(stderrOutput.join('')).not.toContain('secret')
  })

  it('rejects plaintext redis:// when --require-tls is set', async () => {
    const { main } = await import('../src/cli')
    await main(['stats', '--redis', 'redis://localhost:6379', '--require-tls'])
    expect(process.exitCode).toBe(1)
    expect(stderrOutput.join('')).toContain('--require-tls')
  })

  it('allows rediss:// when --require-tls is set', async () => {
    const { main } = await import('../src/cli')
    await main(['stats', '--redis', 'rediss://localhost:6379', '--require-tls'])
    expect(process.exitCode).toBeUndefined()
    expect(stdoutOutput.join('')).toContain('totalKeys')
  })

  it('warns about plaintext redis:// without --require-tls', async () => {
    const { main } = await import('../src/cli')
    await main(['stats', '--redis', 'redis://localhost:6379'])
    expect(stderrOutput.join('')).toContain('Warning')
    expect(stderrOutput.join('')).toContain('redis://')
  })

  it('limits Redis scans to 100000 keys by default and warns when truncated', async () => {
    const firstBatch = Array.from({ length: 60_000 }, (_, index) => `key:${index}`)
    const secondBatch = Array.from({ length: 60_000 }, (_, index) => `key:${index + firstBatch.length}`)
    let scanCalls = 0
    scanImpl = async () => {
      scanCalls += 1
      return scanCalls === 1 ? ['1', firstBatch] : ['0', secondBatch]
    }

    const { main } = await import('../src/cli')
    await main(['stats', '--redis', 'redis://localhost:6379'])

    const output = stdoutOutput.join('')
    expect(output).toContain('"totalKeys": 100000')
    expect(stderrOutput.join('')).toContain('stopped scanning after 100000 keys')
  })

  it('supports a custom Redis scan limit', async () => {
    let scanCalls = 0
    scanImpl = async () => {
      scanCalls += 1
      return scanCalls === 1 ? ['1', ['key:1', 'key:2']] : ['0', ['key:3', 'key:4']]
    }

    const { main } = await import('../src/cli')
    await main(['stats', '--redis', 'redis://localhost:6379', '--limit', '3'])

    const output = stdoutOutput.join('')
    expect(output).toContain('"totalKeys": 3')
    expect(stderrOutput.join('')).toContain('stopped scanning after 3 keys')
  })

  it('does not let one parse error block a later exported main() call', async () => {
    const { main } = await import('../src/cli')

    await main(['stats', '--redis', 'redis://localhost:6379', '--limit', 'nope'])
    expect(process.exitCode).toBe(1)

    stdoutOutput = []
    stderrOutput = []
    await main(['stats', '--redis', 'redis://localhost:6379', '--limit', '2'])

    expect(process.exitCode).toBeUndefined()
    expect(stdoutOutput.join('')).toContain('"totalKeys": 2')
    expect(stderrOutput.join('')).toContain('stopped scanning after 2 keys')
  })

  it('rejects plaintext redis:// in production before connecting', async () => {
    process.env.NODE_ENV = 'production'

    const { main } = await import('../src/cli')
    await main(['stats', '--redis', 'redis://localhost:6379'])

    expect(process.exitCode).toBe(1)
    expect(connectCalls).toBe(0)
    expect(stderrOutput.join('')).toContain('NODE_ENV=production')
    expect(stderrOutput.join('')).toContain('--allow-plaintext')
  })

  it('allows plaintext redis:// in production when explicitly overridden', async () => {
    process.env.NODE_ENV = 'production'

    const { main } = await import('../src/cli')
    await main(['stats', '--redis', 'redis://localhost:6379', '--allow-plaintext'])

    expect(process.exitCode).toBeUndefined()
    expect(connectCalls).toBe(1)
    expect(stderrOutput.join('')).toContain('Warning')
    expect(stdoutOutput.join('')).toContain('totalKeys')
  })

  it('runs RedisTagIndex legacy known-key migrations', async () => {
    const { main } = await import('../src/cli')
    await main([
      'migrate-tag-index',
      '--redis',
      'redis://localhost:6379',
      '--tag-index-prefix',
      'tags:migrate',
      '--known-key-shards',
      '8'
    ])

    expect(migrateCalls).toBe(1)
    expect(tagIndexOptions).toEqual([expect.objectContaining({ prefix: 'tags:migrate', knownKeysShards: 8 })])
    expect(stdoutOutput.join('')).toContain('"migratedKeys": 2')
  })
})
