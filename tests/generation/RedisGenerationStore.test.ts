import { describe, expect, it, vi } from 'vitest'
import { RedisGenerationStore } from '../../src'

describe('RedisGenerationStore', () => {
  it('initializes, reads, sets, and bumps a persisted generation value', async () => {
    const values = new Map<string, string>()
    const client = {
      get: vi.fn(async (key: string) => values.get(key) ?? null),
      set: vi.fn(async (key: string, value: string, mode?: string) => {
        if (mode === 'NX' && values.has(key)) {
          return null
        }
        values.set(key, value)
        return 'OK'
      }),
      incr: vi.fn(async (key: string) => {
        const next = Number.parseInt(values.get(key) ?? '0', 10) + 1
        values.set(key, String(next))
        return next
      })
    }

    const store = new RedisGenerationStore({ client, key: 'cache:generation' })

    await expect(store.get()).resolves.toBeUndefined()
    await expect(store.getOrInitialize(7)).resolves.toBe(7)
    await expect(store.getOrInitialize(3)).resolves.toBe(7)
    await expect(store.bump()).resolves.toBe(8)
    await store.set(12)
    await expect(store.get()).resolves.toBe(12)
  })

  it('rejects invalid generation values and corrupt persisted data', async () => {
    const client = {
      get: vi.fn(async () => 'not-a-number'),
      set: vi.fn(),
      incr: vi.fn()
    }
    const store = new RedisGenerationStore({ client, key: 'cache:generation' })

    await expect(store.get()).rejects.toThrow(/invalid persisted generation/i)
    await expect(store.set(-1)).rejects.toThrow(/non-negative safe integer/i)
    await expect(store.getOrInitialize(1.5)).rejects.toThrow(/non-negative safe integer/i)
  })
})
