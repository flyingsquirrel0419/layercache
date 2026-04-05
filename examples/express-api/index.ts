import express from 'express'
import Redis from 'ioredis'
import { CacheStack, MemoryLayer, RedisLayer } from '../../src'

const redis = new Redis(process.env.REDIS_URL)
const cache = new CacheStack([
  new MemoryLayer({ ttl: 30, maxSize: 5_000 }),
  new RedisLayer({ client: redis, ttl: 300 })
])

const app = express()

app.get('/users/:id', async (req, res) => {
  const user = await cache.get(
    `user:${req.params.id}`,
    async () => {
      return {
        id: Number(req.params.id),
        name: `User ${req.params.id}`,
        source: 'db'
      }
    },
    {
      tags: ['user', `user:${req.params.id}`]
    }
  )

  res.json(user)
})

app.listen(3000)
