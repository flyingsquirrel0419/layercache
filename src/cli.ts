#!/usr/bin/env node
import Redis from 'ioredis'
import { RedisTagIndex } from './invalidation/RedisTagIndex'

interface ParsedArgs {
  command?: string
  redisUrl?: string
  pattern?: string
  tag?: string
  tagIndexPrefix?: string
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv)
  if (!args.command || !args.redisUrl) {
    printUsage()
    process.exitCode = 1
    return
  }

  const redis = new Redis(args.redisUrl)

  try {
    if (args.command === 'stats') {
      const keys = await scanKeys(redis, args.pattern ?? '*')
      process.stdout.write(`${JSON.stringify({ totalKeys: keys.length, pattern: args.pattern ?? '*' }, null, 2)}\n`)
      return
    }

    if (args.command === 'keys') {
      const keys = await scanKeys(redis, args.pattern ?? '*')
      process.stdout.write(`${keys.join('\n')}\n`)
      return
    }

    if (args.command === 'invalidate') {
      if (args.tag) {
        const tagIndex = new RedisTagIndex({ client: redis, prefix: args.tagIndexPrefix ?? 'layercache:tag-index' })
        const keys = await tagIndex.keysForTag(args.tag)
        if (keys.length > 0) {
          await redis.del(...keys)
        }
        process.stdout.write(`${JSON.stringify({ deletedKeys: keys.length, tag: args.tag }, null, 2)}\n`)
        return
      }

      const keys = await scanKeys(redis, args.pattern ?? '*')
      if (keys.length > 0) {
        await redis.del(...keys)
      }
      process.stdout.write(`${JSON.stringify({ deletedKeys: keys.length, pattern: args.pattern ?? '*' }, null, 2)}\n`)
      return
    }

    printUsage()
    process.exitCode = 1
  } finally {
    redis.disconnect()
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
    } else if (token === '--tag-index-prefix') {
      parsed.tagIndexPrefix = value
      index += 1
    }
  }

  return parsed
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
    'Usage:\n'
    + '  layercache stats --redis <url> [--pattern <glob>]\n'
    + '  layercache keys --redis <url> [--pattern <glob>]\n'
    + '  layercache invalidate --redis <url> [--pattern <glob> | --tag <tag>] [--tag-index-prefix <prefix>]\n'
  )
}

if (process.argv[1]?.includes('cli.')) {
  void main()
}
