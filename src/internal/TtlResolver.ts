import type { CacheAdaptiveTtlOptions, CacheWriteOptions, LayerTtlMap } from '../types'

interface AccessProfile {
  hits: number
  lastAccessAt: number
}

interface TtlResolverOptions {
  maxProfileEntries: number
}

type CacheWriteKind = 'value' | 'empty'

const DEFAULT_NEGATIVE_TTL_SECONDS = 60

export class TtlResolver {
  private readonly accessProfiles = new Map<string, AccessProfile>()
  private readonly maxProfileEntries: number

  constructor(options: TtlResolverOptions) {
    this.maxProfileEntries = options.maxProfileEntries
  }

  recordAccess(key: string): void {
    const profile = this.accessProfiles.get(key) ?? { hits: 0, lastAccessAt: Date.now() }
    profile.hits += 1
    profile.lastAccessAt = Date.now()
    this.accessProfiles.set(key, profile)
    this.pruneIfNeeded()
  }

  deleteProfile(key: string): void {
    this.accessProfiles.delete(key)
  }

  clearProfiles(): void {
    this.accessProfiles.clear()
  }

  resolveFreshTtl(
    key: string,
    layerName: string,
    kind: CacheWriteKind,
    options: CacheWriteOptions | undefined,
    fallbackTtl: number | undefined,
    globalNegativeTtl: number | LayerTtlMap | undefined,
    globalTtl?: number | LayerTtlMap
  ): number | undefined {
    const baseTtl =
      kind === 'empty'
        ? this.resolveLayerSeconds(
            layerName,
            options?.negativeTtl,
            globalNegativeTtl,
            this.resolveLayerSeconds(layerName, options?.ttl, globalTtl, fallbackTtl) ?? DEFAULT_NEGATIVE_TTL_SECONDS
          )
        : this.resolveLayerSeconds(layerName, options?.ttl, globalTtl, fallbackTtl)

    const adaptiveTtl = this.applyAdaptiveTtl(key, layerName, baseTtl, options?.adaptiveTtl)
    const jitter = this.resolveLayerSeconds(layerName, options?.ttlJitter, undefined)
    return this.applyJitter(adaptiveTtl, jitter)
  }

  resolveLayerSeconds(
    layerName: string,
    override: number | LayerTtlMap | undefined,
    globalDefault?: number | LayerTtlMap,
    fallback?: number
  ): number | undefined {
    if (override !== undefined) {
      return this.readLayerNumber(layerName, override) ?? fallback
    }

    if (globalDefault !== undefined) {
      return this.readLayerNumber(layerName, globalDefault) ?? fallback
    }

    return fallback
  }

  applyAdaptiveTtl(
    key: string,
    layerName: string,
    ttl: number | undefined,
    adaptiveTtl: boolean | CacheAdaptiveTtlOptions | undefined
  ): number | undefined {
    if (!ttl || !adaptiveTtl) {
      return ttl
    }

    const profile = this.accessProfiles.get(key)
    if (!profile) {
      return ttl
    }

    const config = adaptiveTtl === true ? {} : adaptiveTtl
    const hotAfter = config.hotAfter ?? 3
    if (profile.hits < hotAfter) {
      return ttl
    }

    const step = this.resolveLayerSeconds(layerName, config.step, undefined, Math.max(1, Math.round(ttl / 2))) ?? 0
    const maxTtl = this.resolveLayerSeconds(layerName, config.maxTtl, undefined, ttl + step * 4) ?? ttl
    const multiplier = Math.floor(profile.hits / hotAfter)
    return Math.min(maxTtl, ttl + step * multiplier)
  }

  applyJitter(ttl: number | undefined, jitter: number | undefined): number | undefined {
    if (!ttl || ttl <= 0 || !jitter || jitter <= 0) {
      return ttl
    }

    const delta = (Math.random() * 2 - 1) * jitter
    return Math.max(1, Math.round(ttl + delta))
  }

  private readLayerNumber(layerName: string, value: number | LayerTtlMap): number | undefined {
    if (typeof value === 'number') {
      return value
    }

    return value[layerName]
  }

  private pruneIfNeeded(): void {
    if (this.accessProfiles.size <= this.maxProfileEntries) {
      return
    }

    // Remove oldest 10% of entries
    const toRemove = Math.ceil(this.maxProfileEntries * 0.1)
    let removed = 0
    for (const key of this.accessProfiles.keys()) {
      if (removed >= toRemove) {
        break
      }
      this.accessProfiles.delete(key)
      removed += 1
    }
  }
}
