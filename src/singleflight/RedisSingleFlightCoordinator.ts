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
      try {
        return await worker()
      } finally {
        await this.client.eval(RELEASE_SCRIPT, 1, lockKey, token)
      }
    }

    return waiter()
  }
}
