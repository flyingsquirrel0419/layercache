import { randomUUID } from 'node:crypto'
import type Redis from 'ioredis'
import type { CacheSingleFlightCoordinator, CacheSingleFlightExecutionOptions } from '../types'

interface RedisSingleFlightCoordinatorOptions {
  client: Redis
  prefix?: string
  commandTimeoutMs?: number
}

const RELEASE_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
end
return 0
`

const RENEW_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("pexpire", KEYS[1], ARGV[2])
end
return 0
`

export class RedisSingleFlightCoordinator implements CacheSingleFlightCoordinator {
  private readonly client: Redis
  private readonly prefix: string
  private readonly commandTimeoutMs: number | undefined

  constructor(options: RedisSingleFlightCoordinatorOptions) {
    this.client = options.client
    this.prefix = options.prefix ?? 'layercache:singleflight'
    this.commandTimeoutMs = this.normalizeCommandTimeoutMs(options.commandTimeoutMs)
  }

  async execute<T>(
    key: string,
    options: CacheSingleFlightExecutionOptions,
    worker: () => Promise<T>,
    waiter: () => Promise<T>
  ): Promise<T> {
    const lockKey = `${this.prefix}:${encodeURIComponent(key)}`
    const token = randomUUID()
    const acquired = await this.runCommand(`acquire("${key}")`, () =>
      this.client.set(lockKey, token, 'PX', options.leaseMs, 'NX')
    )

    if (acquired === 'OK') {
      const renewTimer = this.startLeaseRenewal(lockKey, token, options)
      try {
        return await worker()
      } finally {
        if (renewTimer) {
          clearInterval(renewTimer)
        }
        await this.runCommand(`release("${key}")`, () => this.client.eval(RELEASE_SCRIPT, 1, lockKey, token))
      }
    }

    return waiter()
  }

  private startLeaseRenewal(
    lockKey: string,
    token: string,
    options: CacheSingleFlightExecutionOptions
  ): ReturnType<typeof setInterval> | undefined {
    const renewIntervalMs = options.renewIntervalMs ?? Math.max(100, Math.floor(options.leaseMs / 2))
    if (renewIntervalMs <= 0 || renewIntervalMs >= options.leaseMs) {
      return undefined
    }

    const timer = setInterval(() => {
      void this.runCommand(`renew("${lockKey}")`, () =>
        this.client.eval(RENEW_SCRIPT, 1, lockKey, token, String(options.leaseMs))
      ).catch(() => undefined)
    }, renewIntervalMs)
    timer.unref?.()
    return timer
  }

  private normalizeCommandTimeoutMs(value: number | undefined): number | undefined {
    if (value === undefined) {
      return undefined
    }

    if (!Number.isFinite(value) || value <= 0) {
      throw new Error('RedisSingleFlightCoordinator.commandTimeoutMs must be a positive number.')
    }

    return value
  }

  private async runCommand<T>(operation: string, command: () => Promise<T>): Promise<T> {
    const promise = command()
    if (!this.commandTimeoutMs) {
      return promise
    }

    let timer: ReturnType<typeof setTimeout> | undefined

    return Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(
            new Error(`RedisSingleFlightCoordinator command ${operation} timed out after ${this.commandTimeoutMs}ms.`)
          )
        }, this.commandTimeoutMs)
        timer.unref?.()
      })
    ]).finally(() => {
      /* v8 ignore next -- timer is assigned synchronously when commandTimeoutMs is set */
      if (timer) {
        clearTimeout(timer)
      }
    })
  }
}
