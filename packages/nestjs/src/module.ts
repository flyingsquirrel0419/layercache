import { type DynamicModule, Global, Inject, Module, type Provider } from '@nestjs/common'
import { CacheStack } from '../../../src/CacheStack'
import type { CacheLayer, CacheStackOptions } from '../../../src/types'
import { CACHE_STACK } from './constants'

export interface CacheStackModuleOptions {
  layers: CacheLayer[]
  bridgeOptions?: CacheStackOptions
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
}
