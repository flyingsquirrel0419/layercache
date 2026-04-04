import Redis from 'ioredis-mock'
import { describe, expect, it } from 'vitest'
import { RedisLayer } from '../../src/layers/RedisLayer'

function makeLayer(compression: 'gzip' | 'brotli', threshold = 10) {
  return new RedisLayer({
    client: new Redis(),
    compression,
    compressionThreshold: threshold
  })
}

describe('RedisLayer — compression', () => {
  for (const algo of ['gzip', 'brotli'] as const) {
    describe(algo, () => {
      it('round-trips a value above the threshold', async () => {
        const layer = makeLayer(algo, 10)
        const value = { message: 'hello world this is a long enough string to compress' }
        await layer.set('key', value)
        expect(await layer.get('key')).toEqual(value)
      })

      it('round-trips a value below the threshold without compression', async () => {
        const layer = makeLayer(algo, 10_000)
        const value = { x: 1 }
        await layer.set('key', value)
        expect(await layer.get('key')).toEqual(value)
      })

      it('stores compressed and decompresses on get', async () => {
        const layer = makeLayer(algo, 1)
        const largeValue = { data: 'a'.repeat(500) }
        await layer.set('big-key', largeValue)
        const result = await layer.get<typeof largeValue>('big-key')
        expect(result?.data.length).toBe(500)
      })
    })
  }

  it('returns null for a missing key', async () => {
    const layer = makeLayer('gzip')
    expect(await layer.get('missing')).toBeNull()
  })

  it('has() reflects stored key', async () => {
    const layer = makeLayer('gzip')
    await layer.set('k', 1)
    expect(await layer.has('k')).toBe(true)
    expect(await layer.has('missing')).toBe(false)
  })
})
