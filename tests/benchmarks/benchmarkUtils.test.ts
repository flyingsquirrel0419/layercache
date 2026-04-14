import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildPayloadString, normalizeOutageResult } from '../../benchmarks/edge-utils'
import { buildBenchmarkFixtureCandidates } from '../../benchmarks/paths'
import { buildConcurrencyLabel, summarizeQueueAmplification } from '../../benchmarks/queue-amplification-utils'
import { createCountedFetcher, summarizeScenario } from '../../benchmarks/scenario-utils'
import { buildDelayLabel, summarizeGcMetrics } from '../../benchmarks/slow-redis-utils'
import { quantile, summarizeDurations } from '../../benchmarks/stats'
import { buildUserDataset, ensureFixtureFile, findUserById } from '../../benchmarks/workload'

describe('benchmark utils', () => {
  it('summarizes durations and queue amplification metrics', () => {
    expect(quantile([12, 4, 30, 18, 6], 0.5)).toBe(12)
    expect(summarizeDurations('warm-hit', [1, 2, 3, 4, 5])).toEqual({
      label: 'warm-hit',
      count: 5,
      minMs: 1,
      maxMs: 5,
      avgMs: 3,
      medianMs: 3,
      p95Ms: 5
    })

    expect(buildConcurrencyLabel(100)).toBe('x100')
    expect(
      summarizeQueueAmplification({
        delayLabel: '100ms',
        scenario: 'strict-l2-hit',
        concurrency: 10,
        totalWallClockMs: 55.5555,
        requestLatenciesMs: [50.1111, 52.2222, 60.3333, 59.4444, 55.5555],
        baselineWallClockMs: 10
      })
    ).toEqual({
      label: '100ms-strict-l2-hit-x10',
      count: 5,
      minMs: 50.111,
      maxMs: 60.333,
      avgMs: 55.533,
      medianMs: 55.556,
      p95Ms: 60.333,
      delayLabel: '100ms',
      scenario: 'strict-l2-hit',
      concurrency: 10,
      concurrencyLabel: 'x10',
      totalWallClockMs: 55.556,
      amplificationVsSingle: 5.556,
      linearityRatio: 0.556
    })
  })

  it('tracks fetch counts and workload fixtures deterministically', async () => {
    const counted = createCountedFetcher(async (key: string) => ({ key }))
    await expect(counted.run('user:1')).resolves.toEqual({ key: 'user:1' })
    await expect(counted.run('user:2')).resolves.toEqual({ key: 'user:2' })
    expect(counted.getCount()).toBe(2)
    expect(summarizeScenario('stampede', [10, 12, 11], 1).avgMs).toBe(11)

    const users = buildUserDataset(5)
    expect(users[1]?.email).toBe('user2@example.com')
    expect(findUserById(users, 4).profile.region).toBe('sa-east')

    const dir = await mkdtemp(join(tmpdir(), 'layercache-bench-fixture-'))
    const filePath = join(dir, 'users.json')
    try {
      await ensureFixtureFile(filePath, 8)
      const generated = buildBenchmarkFixtureCandidates({ fixturePath: filePath })
      expect(generated[0]).toBe(filePath)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('formats edge and slow-redis helpers', () => {
    expect(buildPayloadString(16)).toHaveLength(16)
    expect(normalizeOutageResult('layered', true, 12.34567)).toEqual({
      scenario: 'layered',
      success: true,
      latencyMs: 12.346,
      error: null
    })

    expect(buildDelayLabel(500)).toBe('500ms')
    expect(summarizeGcMetrics([1.1111, 2.2222, 4.4444])).toEqual({
      gcCount: 3,
      gcTotalMs: 7.778,
      gcMaxMs: 4.444
    })
  })
})
