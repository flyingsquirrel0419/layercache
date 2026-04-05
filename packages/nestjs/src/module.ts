import { type DynamicModule, Global, Inject, Module, type Provider, type Type } from '@nestjs/common'
import { CacheStack } from '../../../src/CacheStack'
import type { CacheLayer, CacheStackOptions } from '../../../src/types'
import { CACHE_STACK } from './constants'

export interface CacheStackModuleOptions {
  layers: CacheLayer[]
  bridgeOptions?: CacheStackOptions
}

export interface CacheStackModuleAsyncOptions {
  /**
   * Tokens to inject into the `useFactory` function.
   */
  inject?: Array<Type | string | symbol>
  /**
   * Async factory function that returns `CacheStackModuleOptions`.
   * Useful when the Redis client or other dependencies must be resolved
   * from the NestJS DI container first.
   *
   * ```ts
   * CacheStackModule.forRootAsync({
   *   inject: [ConfigService],
   *   useFactory: (config: ConfigService) => ({
   *     layers: [new MemoryLayer(), new RedisLayer({ client: createRedis(config) })],
   *   })
   * })
   * ```
   */
  useFactory: (...args: unknown[]) => CacheStackModuleOptions | Promise<CacheStackModuleOptions>
}

export const InjectCacheStack = (): ParameterDecorator & PropertyDecorator => Inject(CACHE_STACK)

@Global()
@Module({})
export class CacheStackModule {
  static forRoot(options: CacheStackModuleOptions): DynamicModule {
    const provider: Provider = {
      provide: CACHE_STACK,
      useFactory: () => new CacheStack(options.layers, options.bridgeOptions)
    }

    return {
      global: true,
      module: CacheStackModule,
      providers: [provider],
      exports: [provider]
    }
  }

  static forRootAsync(options: CacheStackModuleAsyncOptions): DynamicModule {
    const provider: Provider = {
      provide: CACHE_STACK,
      inject: options.inject ?? [],
      useFactory: async (...args: unknown[]) => {
        const resolved = await options.useFactory(...args)
        return new CacheStack(resolved.layers, resolved.bridgeOptions)
      }
    }

    return {
      global: true,
      module: CacheStackModule,
      providers: [provider],
      exports: [provider]
    }
  }
}
