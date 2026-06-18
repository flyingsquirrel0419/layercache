#!/usr/bin/env node
import Redis from 'ioredis'
import { validateCacheKey, validatePattern, validateTag } from './internal/CacheStackValidation'
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
  knownKeysShards?: number
  scanLimit?: number
  requireTls?: boolean
  allowPlaintext?: boolean
  force?: boolean
  parseError?: boolean
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  process.exitCode = undefined
  const args = parseArgs(argv)
  if (args.parseError) {
    return
  }
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

  if (isPlaintextRedisUrl(redisUrl)) {
    if (args.requireTls) {
      process.stderr.write(
        'Error: --require-tls is set but the URL uses redis:// (plaintext). ' +
          'Use rediss:// for TLS-encrypted connections.\n'
      )
      process.exitCode = 1
      return
    }
    if (process.env.NODE_ENV === 'production' && !args.allowPlaintext) {
      process.stderr.write(
        'Error: refusing plaintext redis:// connection because NODE_ENV=production. ' +
          'Use rediss:// for TLS-encrypted connections, or pass --allow-plaintext to explicitly override.\n'
      )
      process.exitCode = 1
      return
    }
    process.stderr.write(
      'Warning: connecting to Redis without TLS (redis://). All data including cached values and credentials ' +
        'will be transmitted in plaintext. Use rediss:// in production environments, or set --require-tls.\n'
    )
  }

  const redis = new Redis(redisUrl, {
    connectTimeout: CONNECT_TIMEOUT_MS,
    lazyConnect: true,
    enableReadyCheck: false
  })

  try {
    await redis.connect().catch((error: unknown) => {
      const message = maskRedisUrlsInText(error instanceof Error ? error.message : String(error))
      throw new Error(`Failed to connect to Redis at ${maskRedisUrl(redisUrl)}: ${message}`)
    })

    if (args.command === 'stats') {
      const pattern = args.pattern ?? '*'
      if (args.pattern && !validateCliInput(args.pattern, validatePattern)) return
      const keys = await scanKeys(redis, pattern, args.scanLimit ?? DEFAULT_SCAN_MAX_KEYS)
      process.stdout.write(`${JSON.stringify({ totalKeys: keys.length, pattern }, null, 2)}\n`)
      return
    }

    if (args.command === 'keys') {
      const pattern = args.pattern ?? '*'
      if (args.pattern && !validateCliInput(args.pattern, validatePattern)) return
      const keys = await scanKeys(redis, pattern, args.scanLimit ?? DEFAULT_SCAN_MAX_KEYS)
      if (keys.length > 0) {
        process.stdout.write(`${keys.join('\n')}\n`)
      }
      return
    }

    if (args.command === 'invalidate') {
      if (args.tag) {
        if (!validateCliInput(args.tag, validateTag)) return

        const tagIndex = new RedisTagIndex({ client: redis, prefix: args.tagIndexPrefix ?? 'layercache:tag-index' })
        const keys = await tagIndex.keysForTag(args.tag)
        if (keys.length > 0) {
          await batchDelete(redis, keys)
        }
        process.stdout.write(`${JSON.stringify({ deletedKeys: keys.length, tag: args.tag }, null, 2)}\n`)
        return
      }

      const effectivePattern = args.pattern ?? '*'
      if (args.pattern && !validateCliInput(args.pattern, validatePattern)) return

      const keys = await scanKeys(redis, effectivePattern, args.scanLimit ?? DEFAULT_SCAN_MAX_KEYS)

      // Require --force for untargeted or explicitly broad bulk invalidation.
      if (requiresForceForInvalidationPattern(effectivePattern) && !args.force && keys.length > 0) {
        process.stderr.write(`Warning: this operation will invalidate ${keys.length} keys. Use --force to confirm.\n`)
        return
      }

      if (keys.length > 0) {
        await batchDelete(redis, keys)
      }
      process.stdout.write(`${JSON.stringify({ deletedKeys: keys.length, pattern: effectivePattern }, null, 2)}\n`)
      return
    }

    if (args.command === 'migrate-tag-index') {
      const tagIndex = new RedisTagIndex({
        client: redis,
        prefix: args.tagIndexPrefix ?? 'layercache:tag-index',
        knownKeysShards: args.knownKeysShards
      })
      const result = await tagIndex.migrateLegacyKnownKeys()
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
      return
    }

    if (args.command === 'inspect') {
      if (!args.key) {
        throw new Error('inspect requires --key <key>.')
      }

      if (!validateCliInput(args.key, validateCacheKey)) return

      const payload = await redis.getBuffer(args.key)
      const ttl = await redis.pttl(args.key)
      const decoded = decodeInspectablePayload(payload)
      process.stdout.write(
        `${JSON.stringify(
          {
            key: args.key,
            exists: payload !== null,
            ttlMs: ttl >= 0 ? ttl : null,
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
      if (!value || value.startsWith('--')) {
        process.stderr.write('Error: --redis requires a value (e.g. redis://localhost:6379)\n')
        process.exitCode = 1
        parsed.parseError = true
        return parsed
      }
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
    } else if (token === '--known-key-shards') {
      if (!value || value.startsWith('--')) {
        process.stderr.write('Error: --known-key-shards requires a positive integer value.\n')
        process.exitCode = 1
        parsed.parseError = true
        return parsed
      }
      const knownKeysShards = Number(value)
      if (!Number.isSafeInteger(knownKeysShards) || knownKeysShards <= 0) {
        process.stderr.write('Error: --known-key-shards requires a positive integer value.\n')
        process.exitCode = 1
        parsed.parseError = true
        return parsed
      }
      parsed.knownKeysShards = knownKeysShards
      index += 1
    } else if (token === '--limit') {
      if (!value || value.startsWith('--')) {
        process.stderr.write('Error: --limit requires a positive integer value.\n')
        process.exitCode = 1
        parsed.parseError = true
        return parsed
      }
      const limit = Number(value)
      if (!Number.isSafeInteger(limit) || limit <= 0) {
        process.stderr.write('Error: --limit requires a positive integer value.\n')
        process.exitCode = 1
        parsed.parseError = true
        return parsed
      }
      parsed.scanLimit = limit
      index += 1
    } else if (token === '--require-tls') {
      parsed.requireTls = true
    } else if (token === '--allow-plaintext') {
      parsed.allowPlaintext = true
    } else if (token === '--force') {
      parsed.force = true
    }
  }

  return parsed
}

const BATCH_DELETE_SIZE = 500
const DEFAULT_SCAN_MAX_KEYS = 100_000

async function batchDelete(redis: Redis, keys: string[]): Promise<void> {
  for (let i = 0; i < keys.length; i += BATCH_DELETE_SIZE) {
    const batch = keys.slice(i, i + BATCH_DELETE_SIZE)
    await redis.del(...batch)
  }
}

async function scanKeys(redis: Redis, pattern: string, limit: number): Promise<string[]> {
  const keys: string[] = []
  let cursor = '0'

  do {
    const [nextCursor, batch] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100)
    cursor = nextCursor
    const remaining = limit - keys.length
    keys.push(...batch.slice(0, remaining))
    if (keys.length >= limit) {
      process.stderr.write(`Warning: stopped scanning after ${limit} keys. Use --limit to raise the scan cap.\n`)
      return keys
    }
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
      '  layercache migrate-tag-index --redis <url> [--tag-index-prefix <prefix>] [--known-key-shards <count>]\n' +
      '\n' +
      'Options:\n' +
      '  --redis <url>               Redis connection URL (e.g. redis://localhost:6379)\n' +
      '  --pattern <glob>            Glob pattern to filter keys (default: *)\n' +
      '  --key <key>                 Exact cache key to inspect\n' +
      '  --tag <tag>                 Invalidate by tag name\n' +
      '  --tag-index-prefix <prefix> Redis key prefix for tag index (default: layercache:tag-index)\n' +
      '  --known-key-shards <count>  Shard count for RedisTagIndex migration (default: 16)\n' +
      '  --limit <count>             Maximum Redis keys to scan (default: 100000)\n' +
      '  --require-tls               Reject non-TLS (redis://) connections\n' +
      '  --allow-plaintext          Explicitly allow redis:// when NODE_ENV=production\n'
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

function isPlaintextRedisUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'redis:'
  } catch {
    // Bare host:port — no TLS
    return true
  }
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

function maskRedisUrlsInText(text: string): string {
  return text.replace(/rediss?:\/\/[^\s"'<>]+/gi, (match) => maskRedisUrl(match))
}

function requiresForceForInvalidationPattern(pattern: string): boolean {
  return pattern.trim() === '*'
}

function validateCliInput(value: string, validator: (v: string) => void): boolean {
  try {
    validator(value)
    return true
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`Error: ${message}\n`)
    process.exitCode = 1
    return false
  }
}

if (process.argv[1]?.endsWith('cli.cjs') || process.argv[1]?.endsWith('cli.js')) {
  void main()
}
