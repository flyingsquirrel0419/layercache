import { describe, expect, it } from 'vitest'
import { PayloadProtection, PayloadProtectionError } from '../../src/internal/PayloadProtection'

describe('PayloadProtection', () => {
  it('reports whether protection is enabled', () => {
    expect(new PayloadProtection({}).isEnabled).toBe(false)
    expect(new PayloadProtection({ encryptionKey: 'secret' }).isEnabled).toBe(true)
    expect(new PayloadProtection({ signingKey: 'secret' }).isEnabled).toBe(true)
  })

  it('returns short unprotected payloads unchanged', () => {
    const protection = new PayloadProtection({})
    const payload = Buffer.from('LCP')
    expect(protection.unprotect(payload)).toEqual(payload)
  })

  it('rejects unprotected plaintext payloads when protection is enabled', () => {
    const protection = new PayloadProtection({ signingKey: 'sig-key' })

    expect(() => protection.unprotect(Buffer.from('{"value":true}'))).toThrow(PayloadProtectionError)
    expect(() => protection.unprotect(Buffer.from('{"value":true}'))).toThrow(/plaintext payload rejected/i)
  })

  it('can explicitly allow legacy plaintext payloads during migrations', () => {
    const protection = new PayloadProtection({ signingKey: 'sig-key', allowLegacyPlaintext: true })
    const payload = Buffer.from('{"value":true}')

    expect(protection.unprotect(payload)).toEqual(payload)
  })

  it('throws when decrypting an encrypted payload without an encryption key', () => {
    const writer = new PayloadProtection({ encryptionKey: 'enc-key' })
    const reader = new PayloadProtection({})

    const payload = writer.protect(Buffer.from('secret'))

    expect(() => reader.unprotect(payload)).toThrow(PayloadProtectionError)
    expect(() => reader.unprotect(payload)).toThrow(/no encryptionKey configured/)
  })

  it('throws when verifying a signed payload without a signing key', () => {
    const writer = new PayloadProtection({ signingKey: 'sig-key' })
    const reader = new PayloadProtection({})

    const payload = writer.protect(Buffer.from('signed'))

    expect(() => reader.unprotect(payload)).toThrow(PayloadProtectionError)
    expect(() => reader.unprotect(payload)).toThrow(/no signingKey configured/)
  })

  it('prefers encryption when both encryptionKey and signingKey are provided', () => {
    const protection = new PayloadProtection({
      encryptionKey: 'enc-key',
      signingKey: 'sig-key'
    })

    const payload = protection.protect(Buffer.from('secret'))

    expect(payload.subarray(0, 5).toString()).toBe('LCP1:')
  })

  it('accepts Buffer key material for encryption and signing', () => {
    const encrypted = new PayloadProtection({
      encryptionKey: Buffer.from('enc-key')
    })
    const signed = new PayloadProtection({
      signingKey: Buffer.from('sig-key')
    })

    const encryptedPayload = encrypted.protect(Buffer.from('secret'))
    const signedPayload = signed.protect(Buffer.from('signed'))

    expect(encrypted.unprotect(encryptedPayload).toString()).toBe('secret')
    expect(signed.unprotect(signedPayload).toString()).toBe('signed')
  })
})
