import { Module } from '@nestjs/common'
import Redis from 'ioredis'
import { MemoryLayer, RedisLayer } from '../../src'
import { CacheBridgeModule } from '../../packages/nestjs/src'

const redis = new Redis(process.env.REDIS_URL)

@Module({
  imports: [
    CacheBridgeModule.forRoot({
      layers: [
        new MemoryLayer({ ttl: 20 }),
        new RedisLayer({ client: redis, ttl: 300 })
      ]
    })
  ]
})
export class AppModule {}
