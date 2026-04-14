import { join } from 'node:path'

export interface BenchmarkPathOptions {
  fixturePath?: string
}

export function buildBenchmarkFixtureCandidates(options: BenchmarkPathOptions = {}): string[] {
  const candidates = [
    options.fixturePath,
    process.env.LAYERCACHE_BENCH_FIXTURE_PATH,
    '/root/cache-test/data/users.json',
    join(process.cwd(), 'data', 'users.json')
  ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0)

  return [...new Set(candidates)]
}

export function resolveBenchmarkFixturePath(options: BenchmarkPathOptions = {}): string {
  const [firstCandidate] = buildBenchmarkFixtureCandidates(options)
  if (!firstCandidate) {
    throw new Error('Unable to resolve a benchmark fixture path.')
  }

  return firstCandidate
}
