export interface GcMetricsSummary {
  gcCount: number
  gcTotalMs: number
  gcMaxMs: number
}

function round(value: number): number {
  return Number(value.toFixed(3))
}

export function buildDelayLabel(delayMs: number): string {
  return `${delayMs}ms`
}

export function summarizeGcMetrics(durationsMs: number[]): GcMetricsSummary {
  if (durationsMs.length === 0) {
    return {
      gcCount: 0,
      gcTotalMs: 0,
      gcMaxMs: 0
    }
  }

  return {
    gcCount: durationsMs.length,
    gcTotalMs: round(durationsMs.reduce((sum, duration) => sum + duration, 0)),
    gcMaxMs: round(Math.max(...durationsMs))
  }
}
