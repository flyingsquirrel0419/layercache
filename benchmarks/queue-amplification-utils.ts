import { type DurationSummary, summarizeDurations } from './stats'

export interface QueueAmplificationSummary extends DurationSummary {
  delayLabel: string
  scenario: string
  concurrency: number
  concurrencyLabel: string
  totalWallClockMs: number
  amplificationVsSingle: number
  linearityRatio: number
}

interface SummarizeQueueAmplificationInput {
  delayLabel: string
  scenario: string
  concurrency: number
  totalWallClockMs: number
  requestLatenciesMs: number[]
  baselineWallClockMs: number
}

function round(value: number): number {
  return Number(value.toFixed(3))
}

export function buildConcurrencyLabel(concurrency: number): string {
  return `x${concurrency}`
}

export function summarizeQueueAmplification(input: SummarizeQueueAmplificationInput): QueueAmplificationSummary {
  if (input.baselineWallClockMs <= 0) {
    throw new Error('baselineWallClockMs must be greater than 0')
  }

  const concurrencyLabel = buildConcurrencyLabel(input.concurrency)
  const totalWallClockMs = round(input.totalWallClockMs)

  return {
    ...summarizeDurations(`${input.delayLabel}-${input.scenario}-${concurrencyLabel}`, input.requestLatenciesMs),
    delayLabel: input.delayLabel,
    scenario: input.scenario,
    concurrency: input.concurrency,
    concurrencyLabel,
    totalWallClockMs,
    amplificationVsSingle: round(totalWallClockMs / input.baselineWallClockMs),
    linearityRatio: round(totalWallClockMs / (input.baselineWallClockMs * input.concurrency))
  }
}
