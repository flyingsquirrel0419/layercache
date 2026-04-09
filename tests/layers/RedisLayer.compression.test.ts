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

function createDeterministicRandom(seed = 0x1234abcd) {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 2 ** 32
  }
}

function randomAscii(random: () => number, length: number): string {
  let value = ''
  for (let index = 0; index < length; index += 1) {
    value += String.fromCharCode(32 + Math.floor(random() * 95))
  }
  return value
}

function toBuffer(payload: string | Buffer): Buffer {
  return Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8')
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

      it('fuzzes encode/decode round-trips and malformed compressed payloads', async () => {
        const random = createDeterministicRandom(algo === 'gzip' ? 0x1a2b3c4d : 0x5e6f7788)
        const layer = makeLayer(algo, 1)
        const internals = layer as unknown as {
          encodePayload: (payload: Buffer) => Promise<string | Buffer>
          decodePayload: (payload: string | Buffer) => Promise<string | Buffer>
        }

        for (let iteration = 0; iteration < 40; iteration += 1) {
          const source = Buffer.from(randomAscii(random, 32 + Math.floor(random() * 256)), 'utf8')
          const encoded = await internals.encodePayload(source)
          const decoded = await internals.decodePayload(encoded)
          expect(toBuffer(decoded)).toEqual(source)

          const encodedBuffer = toBuffer(encoded)
          if (encodedBuffer.byteLength > 12) {
            const truncatedLength = 10 + Math.floor(random() * (encodedBuffer.byteLength - 10))
            const truncated = encodedBuffer.subarray(0, truncatedLength)
            await expect(internals.decodePayload(truncated)).rejects.toThrow()
          }
        }
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

  for (const algo of ['gzip', 'brotli'] as const) {
    describe(`${algo} decompressionMaxBytes`, () => {
      it('rejects decompressed payloads exceeding the byte limit', async () => {
        const layer = new RedisLayer({
          client: new Redis(),
          compression: algo,
          compressionThreshold: 1,
          decompressionMaxBytes: 64
        })

        // Create a value that compresses well but decompresses to > 64 bytes
        const largeValue = { data: 'x'.repeat(512) }
        await layer.set('bomb', largeValue)

        // deserializeOrDelete catches decompression errors and returns null
        // (treating the key as corrupted), so we assert null rather than a throw.
        const result = await layer.get('bomb')
        expect(result).toBeNull()
      })

      it('allows decompressed payloads within the byte limit', async () => {
        const layer = new RedisLayer({
          client: new Redis(),
          compression: algo,
          compressionThreshold: 1,
          decompressionMaxBytes: 1024 * 1024
        })

        const value = { data: 'x'.repeat(512) }
        await layer.set('safe', value)
        await expect(layer.get('safe')).resolves.toEqual(value)
      })
    })
  }
})
