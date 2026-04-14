export interface OutageResult {
  scenario: string
  success: boolean
  latencyMs: number
  error: string | null
}

function round(value: number): number {
  return Number(value.toFixed(3))
}

export function buildPayloadString(bytes: number): string {
  return 'x'.repeat(bytes)
}

export function normalizeOutageResult(
  scenario: string,
  success: boolean,
  latencyMs: number,
  error?: string
): OutageResult {
  return {
    scenario,
    success,
    latencyMs: round(latencyMs),
    error: error ?? null
  }
}
