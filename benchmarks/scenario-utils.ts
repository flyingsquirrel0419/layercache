import { type DurationSummary, summarizeDurations } from './stats'

export interface CountedFetcher<TArgs extends unknown[], TResult> {
  run: (...args: TArgs) => Promise<TResult>
  getCount: () => number
}

export interface ScenarioSummary extends DurationSummary {
  fetchCount: number
}

export function createCountedFetcher<TArgs extends unknown[], TResult>(
  fetcher: (...args: TArgs) => Promise<TResult>
): CountedFetcher<TArgs, TResult> {
  let count = 0

  return {
    run: async (...args: TArgs) => {
      count += 1
      return fetcher(...args)
    },
    getCount: () => count
  }
}

export async function runConcurrent<TResult>(
  count: number,
  task: (index: number) => Promise<TResult>
): Promise<TResult[]> {
  return Promise.all(Array.from({ length: count }, (_, index) => task(index)))
}

export function summarizeScenario(label: string, samples: number[], fetchCount: number): ScenarioSummary {
  return {
    ...summarizeDurations(label, samples),
    fetchCount
  }
}
