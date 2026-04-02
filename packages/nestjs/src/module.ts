import { DynamicModule, Global, Inject, Module, type Provider } from '@nestjs/common'
import { CacheBridge } from '../../../src/CacheBridge'
import type { CacheBridgeOptions, CacheLayer } from '../../../src/types'
import { CACHE_BRIDGE } from './constants'

export interface CacheBridgeModuleOptions {
  layers: CacheLayer[]
  bridgeOptions?: CacheBridgeOptions
}

export const InjectCacheBridge = (): ParameterDecorator & PropertyDecorator => Inject(CACHE_BRIDGE)

@Global()
@Module({})
export class CacheBridgeModule {
  static forRoot(options: CacheBridgeModuleOptions): DynamicModule {
    const provider: Provider = {
      provide: CACHE_BRIDGE,
      useFactory: () => new CacheBridge(options.layers, options.bridgeOptions)
    }

    return {
      global: true,
      module: CacheBridgeModule,
      providers: [provider],
      exports: [provider]
    }
  }
}
