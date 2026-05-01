import { randomBytes } from 'node:crypto'
import type { CacheAdaptiveTtlOptions, CacheTtlPolicy, CacheWriteOptions, LayerTtlMap } from '../types'

interface AccessProfile {
  hits: number
  lastAccessAt: number
}

interface TtlResolverOptions {
  maxProfileEntries: number
}

type CacheWriteKind = 'value' | 'empty'

const DEFAULT_NEGATIVE_TTL_MS = 60_000

export const secureRandom = {
  value(): number {
    return randomBytes(4).readUInt32BE(0) / 0x100000000
  }
}

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
    globalTtl?: number | LayerTtlMap,
    value?: unknown
  ): number | undefined {
    const policyTtl = kind === 'value' ? this.resolvePolicyTtl(key, value, options?.ttlPolicy) : undefined
    const baseTtl =
      kind === 'empty'
        ? this.resolveLayerMs(
            layerName,
            options?.negativeTtl,
            globalNegativeTtl,
            this.resolveLayerMs(layerName, options?.ttl, globalTtl, policyTtl ?? fallbackTtl) ?? DEFAULT_NEGATIVE_TTL_MS
          )
        : this.resolveLayerMs(layerName, options?.ttl, globalTtl, policyTtl ?? fallbackTtl)

    const adaptiveTtl = this.applyAdaptiveTtl(key, layerName, baseTtl, options?.adaptiveTtl)
    const jitter = this.resolveLayerMs(layerName, options?.ttlJitter, undefined)
    return this.applyJitter(adaptiveTtl, jitter)
  }

  resolveLayerMs(
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

    const step = this.resolveLayerMs(layerName, config.step, undefined, Math.max(1, Math.round(ttl / 2))) ?? 0
    const maxTtl = this.resolveLayerMs(layerName, config.maxTtl, undefined, ttl + step * 4) ?? ttl
    const multiplier = Math.floor(profile.hits / hotAfter)
    return Math.min(maxTtl, ttl + step * multiplier)
  }

  applyJitter(ttl: number | undefined, jitter: number | undefined): number | undefined {
    if (!ttl || ttl <= 0 || !jitter || jitter <= 0) {
      return ttl
    }

    const delta = (secureRandom.value() * 2 - 1) * jitter
    return Math.max(1, Math.round(ttl + delta))
  }

  private resolvePolicyTtl(key: string, value: unknown, policy: CacheTtlPolicy | undefined): number | undefined {
    if (!policy) {
      return undefined
    }

    if (typeof policy === 'function') {
      return policy({ key, value })
    }

    const now = new Date()
    if (policy === 'until-midnight') {
      const nextMidnight = new Date(now)
      nextMidnight.setHours(24, 0, 0, 0)
      return Math.max(1, Math.ceil(nextMidnight.getTime() - now.getTime()))
    }

    if (policy === 'next-hour') {
      const nextHour = new Date(now)
      nextHour.setMinutes(60, 0, 0)
      return Math.max(1, Math.ceil(nextHour.getTime() - now.getTime()))
    }

    const alignToMs = policy.alignTo
    const currentMs = Date.now()
    const nextBoundary = Math.ceil((currentMs + 1) / alignToMs) * alignToMs
    return Math.max(1, nextBoundary - currentMs)
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

    // Remove least recently accessed 10% of entries
    const toRemove = Math.ceil(this.maxProfileEntries * 0.1)
    const sorted = [...this.accessProfiles.entries()].sort((a, b) => a[1].lastAccessAt - b[1].lastAccessAt)
    for (let i = 0; i < toRemove && i < sorted.length; i++) {
      const entry = sorted[i]
      if (entry) {
        this.accessProfiles.delete(entry[0])
      }
    }
  }
}
