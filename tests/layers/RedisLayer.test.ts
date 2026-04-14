import { Transform } from 'node:stream'
import Redis from 'ioredis-mock'
import { describe, expect, it, vi } from 'vitest'
import { RedisLayer } from '../../src/layers/RedisLayer'
import { JsonSerializer } from '../../src/serialization/JsonSerializer'
import { MsgpackSerializer } from '../../src/serialization/MsgpackSerializer'

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

class EchoTransform extends Transform {
  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null, data?: Buffer) => void
  ) {
    callback(null, chunk)
  }
}

class ErrorTransform extends Transform {
  override _transform(_chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    callback(new Error('boom'))
  }
}

describe('RedisLayer', () => {
  it('round-trips json values', async () => {
    const client = new Redis()
    const layer = new RedisLayer({ client, ttl: 60 })

    await layer.set('user:1', { id: 1, name: 'Alice' })

    await expect(layer.get('user:1')).resolves.toEqual({ id: 1, name: 'Alice' })
  })

  it('supports empty bulk operations and unprefixed dbsize counting', async () => {
    const client = new Redis()
    const layer = new RedisLayer({ client, allowUnprefixedClear: true })

    await expect(layer.getMany([])).resolves.toEqual([])
    await expect(layer.setMany([])).resolves.toBeUndefined()
    await expect(layer.deleteMany([])).resolves.toBeUndefined()

    await layer.set('a', 1)
    await layer.set('b', 2)
    await expect(layer.size()).resolves.toBe(await client.dbsize())
  })

  it('supports alternate serializers', async () => {
    const client = new Redis()
    const layer = new RedisLayer({ client, serializer: new MsgpackSerializer() })

    await layer.set('numbers', [1, 2, 3])

    await expect(layer.get('numbers')).resolves.toEqual([1, 2, 3])
  })

  it('supports bulk set/get, key iteration, and ttl/has semantics', async () => {
    const client = new Redis()
    const layer = new RedisLayer({ client, prefix: 'cache:' })

    await layer.setMany([
      { key: 'a', value: 1, ttl: 10 },
      { key: 'b', value: 2 }
    ])

    await expect(layer.getMany(['a', 'b'])).resolves.toEqual([1, 2])
    await expect(layer.has('a')).resolves.toBe(true)
    await expect(layer.ttl('a')).resolves.toBeGreaterThan(0)
    await expect(layer.ttl('b')).resolves.toBeNull()
    await expect(layer.ttl('missing')).resolves.toBeNull()

    const keys = await layer.keys()
    expect(keys.sort()).toEqual(['a', 'b'])

    const visited: string[] = []
    await layer.forEachKey(async (key) => {
      visited.push(key)
    })
    expect(visited.sort()).toEqual(['a', 'b'])
  })

  it('treats deserialization failures as cache misses and removes the corrupted key', async () => {
    const client = new Redis()
    const layer = new RedisLayer({ client, serializer: new MsgpackSerializer() })

    await client.set('broken', 'not-msgpack')

    await expect(layer.get('broken')).resolves.toBeNull()
    await expect(client.get('broken')).resolves.toBeNull()
  })

  it('treats pipeline command errors and corrupted payloads as cache misses in bulk reads', async () => {
    const client = new Redis()
    const layer = new RedisLayer({ client, serializer: new MsgpackSerializer() })

    await layer.set('good', { ok: true })
    await client.set('broken', 'not-msgpack')
    await client.lpush('wrongtype', 'value')

    await expect(layer.getMany(['good', 'broken', 'wrongtype'])).resolves.toEqual([{ ok: true }, null, null])
    await expect(client.get('broken')).resolves.toBeNull()
  })

  it('refuses to clear an unprefixed redis namespace unless explicitly allowed', async () => {
    const client = new Redis()
    const layer = new RedisLayer({ client })

    await layer.set('user:1', { id: 1 })

    await expect(layer.clear()).rejects.toThrow(/requires a prefix or allowUnprefixedClear=true/i)
    await expect(layer.get('user:1')).resolves.toEqual({ id: 1 })
  })

  it('clears prefixed keys without touching other redis data', async () => {
    const client = new Redis()
    const prefixedLayer = new RedisLayer({ client, prefix: 'cache:' })
    const otherLayer = new RedisLayer({ client, prefix: 'other:' })

    await prefixedLayer.set('user:1', { id: 1 })
    await otherLayer.set('user:1', { id: 2 })

    await prefixedLayer.clear()

    await expect(prefixedLayer.get('user:1')).resolves.toBeNull()
    await expect(otherLayer.get('user:1')).resolves.toEqual({ id: 2 })
  })

  it('counts prefixed keys without materializing the full key list', async () => {
    const client = new Redis()
    const prefixedLayer = new RedisLayer({ client, prefix: 'cache:' })
    const otherLayer = new RedisLayer({ client, prefix: 'other:' })

    await prefixedLayer.set('user:1', { id: 1 })
    await prefixedLayer.set('user:2', { id: 2 })
    await otherLayer.set('user:1', { id: 3 })

    await expect(prefixedLayer.size()).resolves.toBe(2)
    await expect(otherLayer.size()).resolves.toBe(1)
  })

  it('can deserialize with fallback serializers and rewrite using the primary serializer', async () => {
    const client = new Redis()
    const json = new JsonSerializer()
    const msgpack = new MsgpackSerializer()
    const layer = new RedisLayer({ client, serializer: [msgpack, json] })

    await client.set('legacy', json.serialize({ legacy: true }) as string)

    await expect(layer.get('legacy')).resolves.toEqual({ legacy: true })

    const raw = await client.getBuffer('legacy')
    expect(raw).not.toBeNull()
    expect(() => msgpack.deserialize(raw as Buffer)).not.toThrow()
  })

  it('treats oversized decompressed payloads as cache misses and removes the key', async () => {
    const client = new Redis()
    const layer = new RedisLayer({
      client,
      compression: 'gzip',
      compressionThreshold: 1,
      decompressionMaxBytes: 64
    })

    await layer.set('compressed-bomb', 'x'.repeat(2_048))

    await expect(layer.get('compressed-bomb')).resolves.toBeNull()
    await expect(client.getBuffer('compressed-bomb')).resolves.toBeNull()
  })

  it('supports brotli compression and deleteMany on prefixed keys', async () => {
    const client = new Redis()
    const layer = new RedisLayer({
      client,
      prefix: 'brotli:',
      compression: 'brotli',
      compressionThreshold: 1
    })

    await layer.set('a', 'x'.repeat(2048))
    await layer.set('b', 'y'.repeat(2048))
    await expect(layer.get('a')).resolves.toBe('x'.repeat(2048))

    await layer.deleteMany(['a', 'b'])
    await expect(layer.get('a')).resolves.toBeNull()
    await expect(layer.get('b')).resolves.toBeNull()
  })

  it('pings redis health and optionally disconnects on dispose', async () => {
    const client = new Redis()
    const disconnect = vi.spyOn(client, 'disconnect')
    const layer = new RedisLayer({ client, disconnectOnDispose: true })

    await expect(layer.ping()).resolves.toBe(true)
    await layer.dispose()
    expect(disconnect).toHaveBeenCalled()
  })

  it('returns false when ping throws', async () => {
    const client = {
      ping: vi.fn(async () => {
        throw new Error('offline')
      }),
      disconnect: vi.fn()
    } as unknown as Redis

    const layer = new RedisLayer({ client })
    await expect(layer.ping()).resolves.toBe(false)
  })

  it('fails slow commands when commandTimeoutMs is configured', async () => {
    const client = {
      getBuffer: vi.fn(async () => {
        await sleep(40)
        return Buffer.from(JSON.stringify({ ok: true }))
      }),
      disconnect: vi.fn()
    } as unknown as Redis

    const layer = new RedisLayer({ client, commandTimeoutMs: 10 })

    await expect(layer.get('slow')).rejects.toThrow(/timed out after 10ms/i)
  })

  it('rejects invalid commandTimeoutMs values', () => {
    const client = new Redis()

    expect(() => new RedisLayer({ client, commandTimeoutMs: 0 })).toThrow(/positive number/i)
    expect(() => new RedisLayer({ client, commandTimeoutMs: Number.NaN })).toThrow(/positive number/i)
  })

  it('can clear unprefixed keys when explicitly allowed', async () => {
    const client = new Redis()
    const layer = new RedisLayer({ client, allowUnprefixedClear: true })

    await layer.set('user:1', { id: 1 })
    await layer.clear()

    await expect(layer.get('user:1')).resolves.toBeNull()
  })

  it('covers serializer, rewrite, and decompression helper branches', async () => {
    const client = new Redis()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const layer = new RedisLayer({
      client,
      compression: 'gzip',
      compressionThreshold: 1_000
    })

    await expect(
      (
        layer as {
          encodePayload: (payload: string | Buffer) => Promise<string | Buffer>
        }
      ).encodePayload('small')
    ).resolves.toBe('small')
    await expect(
      (
        layer as {
          decodePayload: (payload: string | Buffer) => Promise<string | Buffer>
        }
      ).decodePayload('plain')
    ).resolves.toBe('plain')
    await expect(
      (
        layer as {
          decodePayload: (payload: string | Buffer) => Promise<string | Buffer>
        }
      ).decodePayload(Buffer.from('not-compressed'))
    ).resolves.toEqual(Buffer.from('not-compressed'))

    const ttlSpy = vi.spyOn(client, 'ttl').mockResolvedValueOnce(-1)
    const setSpy = vi.spyOn(client, 'set')
    await (
      layer as {
        rewriteWithPrimarySerializer: (key: string, value: unknown) => Promise<void>
      }
    ).rewriteWithPrimarySerializer('rewrite:key', { ok: true })
    expect(ttlSpy).toHaveBeenCalled()
    expect(setSpy).toHaveBeenCalled()

    const delSpy = vi.spyOn(client, 'del').mockRejectedValueOnce(new Error('cannot delete'))
    await (
      layer as {
        deleteCorruptedKey: (key: string) => Promise<void>
      }
    ).deleteCorruptedKey('broken')
    expect(delSpy).toHaveBeenCalled()
    expect(warnSpy).toHaveBeenCalled()

    const emptySerializerLayer = new RedisLayer({ client, serializer: [new JsonSerializer()] })
    ;(emptySerializerLayer as { serializers: unknown[] }).serializers = []
    expect(() => (emptySerializerLayer as { primarySerializer: () => unknown }).primarySerializer()).toThrow(
      /at least one serializer/i
    )

    warnSpy.mockRestore()
  })

  it('handles decompressor end and error events in the limit helper', async () => {
    const client = new Redis()
    const layer = new RedisLayer({
      client,
      decompressionMaxBytes: 16
    })

    await expect(
      (
        layer as unknown as {
          decompressWithLimit: (decompressor: Transform, payload: Buffer) => Promise<Buffer>
        }
      ).decompressWithLimit(new EchoTransform(), Buffer.from('payload'))
    ).resolves.toEqual(Buffer.from('payload'))

    await expect(
      (
        layer as unknown as {
          decompressWithLimit: (decompressor: Transform, payload: Buffer) => Promise<Buffer>
        }
      ).decompressWithLimit(new ErrorTransform(), Buffer.from('payload'))
    ).rejects.toThrow('boom')
  })
})
