import { randomUUID } from 'node:crypto'
import type Redis from 'ioredis'
import type { CacheSingleFlightCoordinator, CacheSingleFlightExecutionOptions } from '../types'

interface RedisSingleFlightCoordinatorOptions {
  client: Redis
  prefix?: string
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

  constructor(options: RedisSingleFlightCoordinatorOptions) {
    this.client = options.client
    this.prefix = options.prefix ?? 'layercache:singleflight'
  }

  async execute<T>(
    key: string,
    options: CacheSingleFlightExecutionOptions,
    worker: () => Promise<T>,
    waiter: () => Promise<T>
  ): Promise<T> {
    const lockKey = `${this.prefix}:${encodeURIComponent(key)}`
    const token = randomUUID()
    const acquired = await this.client.set(lockKey, token, 'PX', options.leaseMs, 'NX')

    if (acquired === 'OK') {
      const renewTimer = this.startLeaseRenewal(lockKey, token, options)
      try {
        return await worker()
      } finally {
        if (renewTimer) {
          clearInterval(renewTimer)
        }
        await this.client.eval(RELEASE_SCRIPT, 1, lockKey, token)
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
      void this.client.eval(RENEW_SCRIPT, 1, lockKey, token, String(options.leaseMs)).catch(() => undefined)
    }, renewIntervalMs)
    timer.unref?.()
    return timer
  }
}
