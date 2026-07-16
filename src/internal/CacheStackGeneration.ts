import type { CacheGenerationCleanupOptions } from '../types'

type GenerationCleanupConfig = boolean | CacheGenerationCleanupOptions | undefined

const DEFAULT_GENERATION_CLEANUP_BATCH_SIZE = 500
const DEFAULT_GENERATION_CLEANUP_MAX_MATCHES = 10_000

export function generationPrefix(generation: number | undefined): string {
  return generation === undefined ? '' : `v${generation}:`
}

export function qualifyGenerationKey(key: string, generation: number | undefined): string {
  const prefix = generationPrefix(generation)
  return prefix ? `${prefix}${key}` : key
}

export function qualifyGenerationPattern(pattern: string, generation: number | undefined): string {
  return qualifyGenerationKey(pattern, generation)
}

export function stripGenerationPrefix(key: string, generation: number | undefined): string {
  const prefix = generationPrefix(generation)
  if (!prefix || !key.startsWith(prefix)) {
    return key
  }

  return key.slice(prefix.length)
}

export function resolveGenerationCleanupTarget({
  previousGeneration,
  nextGeneration,
  generationCleanup
}: {
  previousGeneration: number | undefined
  nextGeneration: number
  generationCleanup: GenerationCleanupConfig
}): number | null {
  if (!generationCleanup || previousGeneration === undefined || previousGeneration === nextGeneration) {
    return null
  }

  return previousGeneration
}

export function resolveGenerationCleanupBatchSize(generationCleanup: GenerationCleanupConfig): number {
  if (typeof generationCleanup !== 'object' || generationCleanup === null) {
    return DEFAULT_GENERATION_CLEANUP_BATCH_SIZE
  }

  return generationCleanup.batchSize ?? DEFAULT_GENERATION_CLEANUP_BATCH_SIZE
}

export function resolveGenerationCleanupMaxMatches(generationCleanup: GenerationCleanupConfig): number | false {
  if (typeof generationCleanup !== 'object' || generationCleanup === null) {
    return DEFAULT_GENERATION_CLEANUP_MAX_MATCHES
  }

  return generationCleanup.maxMatches ?? DEFAULT_GENERATION_CLEANUP_MAX_MATCHES
}

export function planGenerationCleanupBatches(keys: string[], generationCleanup: GenerationCleanupConfig): string[][] {
  if (keys.length === 0) {
    return []
  }

  const batchSize = resolveGenerationCleanupBatchSize(generationCleanup)
  const batches: string[][] = []

  for (let index = 0; index < keys.length; index += batchSize) {
    batches.push(keys.slice(index, index + batchSize))
  }

  return batches
}
