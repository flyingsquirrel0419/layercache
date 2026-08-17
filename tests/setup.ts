import { afterEach } from 'vitest'
import { disconnectAllTestRedis } from './helpers/test-redis'

afterEach(() => {
  disconnectAllTestRedis()
})
