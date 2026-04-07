#!/usr/bin/env node
import Redis from 'ioredis'
import { isStoredValueEnvelope, resolveStoredValue } from './internal/StoredValue'
import { RedisTagIndex } from './invalidation/RedisTagIndex'

const CONNECT_TIMEOUT_MS = 5_000

interface ParsedArgs {
  command?: string
  redisUrl?: string
  pattern?: string
  tag?: string
  key?: string
  tagIndexPrefix?: string
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv)
  if (!args.command || !args.redisUrl) {
    printUsage()
    process.exitCode = 1
    return
  }

  const redisUrl = validateRedisUrl(args.redisUrl)
  if (!redisUrl) {
    process.stderr.write('Error: invalid Redis URL. Expected format: redis://[user:password@]host[:port][/db]\n')
    process.exitCode = 1
    return
  }

  const redis = new Redis(redisUrl, {
    connectTimeout: CONNECT_TIMEOUT_MS,
    lazyConnect: true,
    enableReadyCheck: false
  })

  try {
    await redis.connect().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`Failed to connect to Redis: ${message}`)
    })

    if (args.command === 'stats') {
      const keys = await scanKeys(redis, args.pattern ?? '*')
      process.stdout.write(`${JSON.stringify({ totalKeys: keys.length, pattern: args.pattern ?? '*' }, null, 2)}\n`)
      return
    }

    if (args.command === 'keys') {
      const keys = await scanKeys(redis, args.pattern ?? '*')
      if (keys.length > 0) {
        process.stdout.write(`${keys.join('\n')}\n`)
      }
      return
    }

    if (args.command === 'invalidate') {
      if (args.tag) {
        const tagIndex = new RedisTagIndex({ client: redis, prefix: args.tagIndexPrefix ?? 'layercache:tag-index' })
        const keys = await tagIndex.keysForTag(args.tag)
        if (keys.length > 0) {
          await batchDelete(redis, keys)
        }
        process.stdout.write(`${JSON.stringify({ deletedKeys: keys.length, tag: args.tag }, null, 2)}\n`)
        return
      }

      const keys = await scanKeys(redis, args.pattern ?? '*')
      if (keys.length > 0) {
        await batchDelete(redis, keys)
      }
      process.stdout.write(`${JSON.stringify({ deletedKeys: keys.length, pattern: args.pattern ?? '*' }, null, 2)}\n`)
      return
    }

    if (args.command === 'inspect') {
      if (!args.key) {
        throw new Error('inspect requires --key <key>.')
      }

      const payload = await redis.getBuffer(args.key)
      const ttl = await redis.ttl(args.key)
      const decoded = decodeInspectablePayload(payload)
      process.stdout.write(
        `${JSON.stringify(
          {
            key: args.key,
            exists: payload !== null,
            ttlSeconds: ttl >= 0 ? ttl : null,
            sizeBytes: payload?.byteLength ?? 0,
            isEnvelope: isStoredValueEnvelope(decoded),
            state: payload === null ? null : resolveStoredValue(decoded).state,
            preview: summarizeInspectableValue(decoded)
          },
          null,
          2
        )}\n`
      )
      return
    }

    printUsage()
    process.exitCode = 1
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`Error: ${message}\n`)
    process.exitCode = 1
  } finally {
    redis.disconnect()
  }
}

/**
 * Validates that the given string is an acceptable Redis URL.
 * Returns the URL unchanged if valid, or null if invalid.
 */
function validateRedisUrl(url: string): string | null {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'redis:' && parsed.protocol !== 'rediss:') {
      return null
    }
    return url
  } catch {
    // Also accept bare host:port or just a host (ioredis accepts these)
    if (/^[A-Za-z0-9._-]+(:\d+)?$/.test(url)) {
      return url
    }
    return null
  }
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command, ...rest] = argv
  const parsed: ParsedArgs = { command }

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index]
    const value = rest[index + 1]
    if (token === '--redis') {
      parsed.redisUrl = value
      index += 1
    } else if (token === '--pattern') {
      parsed.pattern = value
      index += 1
    } else if (token === '--tag') {
      parsed.tag = value
      index += 1
    } else if (token === '--key') {
      parsed.key = value
      index += 1
    } else if (token === '--tag-index-prefix') {
      parsed.tagIndexPrefix = value
      index += 1
    }
  }

  return parsed
}

const BATCH_DELETE_SIZE = 500

async function batchDelete(redis: Redis, keys: string[]): Promise<void> {
  for (let i = 0; i < keys.length; i += BATCH_DELETE_SIZE) {
    const batch = keys.slice(i, i + BATCH_DELETE_SIZE)
    await redis.del(...batch)
  }
}

async function scanKeys(redis: Redis, pattern: string): Promise<string[]> {
  const keys: string[] = []
  let cursor = '0'

  do {
    const [nextCursor, batch] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100)
    cursor = nextCursor
    keys.push(...batch)
  } while (cursor !== '0')

  return keys
}

function printUsage(): void {
  process.stdout.write(
    'Usage:\n' +
      '  layercache stats --redis <url> [--pattern <glob>]\n' +
      '  layercache keys --redis <url> [--pattern <glob>]\n' +
      '  layercache inspect --redis <url> --key <key>\n' +
      '  layercache invalidate --redis <url> [--pattern <glob> | --tag <tag>] [--tag-index-prefix <prefix>]\n' +
      '\n' +
      'Options:\n' +
      '  --redis <url>               Redis connection URL (e.g. redis://localhost:6379)\n' +
      '  --pattern <glob>            Glob pattern to filter keys (default: *)\n' +
      '  --key <key>                 Exact cache key to inspect\n' +
      '  --tag <tag>                 Invalidate by tag name\n' +
      '  --tag-index-prefix <prefix> Redis key prefix for tag index (default: layercache:tag-index)\n'
  )
}

function decodeInspectablePayload(payload: Buffer | null): unknown {
  if (payload === null) {
    return null
  }

  const text = payload.toString('utf8')
  try {
    return JSON.parse(text)
  } catch {
    return text.length > 256 ? `${text.slice(0, 256)}...` : text
  }
}

function summarizeInspectableValue(value: unknown): unknown {
  if (isStoredValueEnvelope(value)) {
    return {
      kind: value.kind,
      value: value.value,
      freshUntil: value.freshUntil,
      staleUntil: value.staleUntil,
      errorUntil: value.errorUntil
    }
  }

  return value
}

function maskRedisUrl(url: string): string {
  try {
    const parsed = new URL(url)
    if (parsed.password) {
      parsed.password = '***'
    }
    return parsed.toString()
  } catch {
    // Bare host:port — no credentials to mask
    return url.replace(/:([^@/]+)@/, ':***@')
  }
}

if (process.argv[1]?.includes('cli.')) {
  void main()
}
