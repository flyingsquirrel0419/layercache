export interface DurationSummary {
  label: string
  count: number
  minMs: number
  maxMs: number
  avgMs: number
  medianMs: number
  p95Ms: number
}

function round(value: number): number {
  return Number(value.toFixed(3))
}

export function quantile(samples: number[], percentile: number): number {
  if (samples.length === 0) {
    throw new Error('quantile requires at least one sample')
  }

  const sorted = [...samples].sort((left, right) => left - right)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * percentile) - 1))
  const value = sorted[index]
  if (value === undefined) {
    throw new Error('quantile computed an invalid index')
  }

  return value
}

export function summarizeDurations(label: string, samples: number[]): DurationSummary {
  if (samples.length === 0) {
    throw new Error('summarizeDurations requires at least one sample')
  }

  const total = samples.reduce((sum, sample) => sum + sample, 0)

  return {
    label,
    count: samples.length,
    minMs: round(Math.min(...samples)),
    maxMs: round(Math.max(...samples)),
    avgMs: round(total / samples.length),
    medianMs: round(quantile(samples, 0.5)),
    p95Ms: round(quantile(samples, 0.95))
  }
}
