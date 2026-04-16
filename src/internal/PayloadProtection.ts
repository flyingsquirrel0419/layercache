import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

const MAGIC_ENCRYPTED = Buffer.from('LCP1:')
const MAGIC_SIGNED = Buffer.from('LCS1:')
const ALGORITHM = 'aes-256-gcm'
const IV_LENGTH = 12
const AUTH_TAG_LENGTH = 16
const HMAC_LENGTH = 32

export interface PayloadProtectionOptions {
  /**
   * Key used to encrypt cached data at rest (AES-256-GCM).
   * Accepts a string (UTF-8 encoded) or a Buffer. The raw key material is
   * hashed with SHA-256 to produce the actual cipher key.
   */
  encryptionKey?: string | Buffer
  /**
   * Key used to sign cached data for integrity verification (HMAC-SHA256).
   * Accepts a string (UTF-8 encoded) or a Buffer. The raw key material is
   * hashed with SHA-256 to produce the actual HMAC key.
   *
   * Ignored when `encryptionKey` is also provided — AES-GCM already provides
   * integrity via its authentication tag.
   */
  signingKey?: string | Buffer
}

/**
 * Encrypts and/or signs byte payloads to protect cache data at rest.
 *
 * - When only `encryptionKey` is set: payloads are encrypted with AES-256-GCM
 *   (which also provides authenticated encryption / integrity).
 * - When only `signingKey` is set: payloads are signed with HMAC-SHA256.
 * - When both are set: `encryptionKey` takes precedence (GCM auth tag
 *   covers integrity).
 * - When neither is set: payloads pass through unchanged.
 *
 * The binary format uses a short magic header so that readers can distinguish
 * protected from legacy plaintext payloads without external metadata:
 *
 * - Encrypted: `LCP1:` (5 bytes) ‖ IV (12) ‖ authTag (16) ‖ ciphertext
 * - Signed:    `LCS1:` (4 bytes) ‖ HMAC (32) ‖ plaintext
 */
export class PayloadProtection {
  private readonly encryptionKey: Buffer | undefined
  private readonly signingKey: Buffer | undefined

  constructor(options: PayloadProtectionOptions) {
    if (options.encryptionKey) {
      const raw = Buffer.isBuffer(options.encryptionKey)
        ? options.encryptionKey
        : Buffer.from(options.encryptionKey, 'utf8')
      this.encryptionKey = createHash('sha256').update(raw).digest()
    }

    if (options.signingKey && !options.encryptionKey) {
      const raw = Buffer.isBuffer(options.signingKey) ? options.signingKey : Buffer.from(options.signingKey, 'utf8')
      this.signingKey = createHash('sha256').update(raw).digest()
    }
  }

  /** Returns `true` when any protection (encryption or signing) is configured. */
  get isEnabled(): boolean {
    return this.encryptionKey !== undefined || this.signingKey !== undefined
  }

  /**
   * Applies the configured protection (encryption or signing) to a payload.
   * Returns the input unchanged when no protection is configured.
   */
  protect(payload: Buffer): Buffer {
    if (this.encryptionKey) {
      return this.encrypt(payload, this.encryptionKey)
    }
    if (this.signingKey) {
      return this.sign(payload, this.signingKey)
    }
    return payload
  }

  /**
   * Removes the protection layer from a payload.
   *
   * - Protected payloads are decrypted/verified using the configured keys.
   * - Legacy unprotected payloads pass through unchanged when **no** protection
   *   is configured.
   * - If protection **is** configured but the payload is not protected, the
   *   payload is treated as a legacy entry. Callers can handle this case by
   *   checking `isEnabled` separately.
   */
  unprotect(payload: Buffer): Buffer {
    if (this.startsWith(payload, MAGIC_ENCRYPTED)) {
      if (!this.encryptionKey) {
        throw new PayloadProtectionError('Encrypted payload but no encryptionKey configured.')
      }
      return this.decrypt(payload, this.encryptionKey)
    }

    if (this.startsWith(payload, MAGIC_SIGNED)) {
      if (!this.signingKey) {
        throw new PayloadProtectionError('Signed payload but no signingKey configured.')
      }
      return this.verify(payload, this.signingKey)
    }

    return payload
  }

  // ── Encryption (AES-256-GCM) ──────────────────────────────────────────

  private encrypt(plaintext: Buffer, key: Buffer): Buffer {
    const iv = randomBytes(IV_LENGTH)
    const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH })
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()])
    const authTag = cipher.getAuthTag()
    return Buffer.concat([MAGIC_ENCRYPTED, iv, authTag, encrypted])
  }

  private decrypt(payload: Buffer, key: Buffer): Buffer {
    const headerEnd = MAGIC_ENCRYPTED.length
    const iv = payload.subarray(headerEnd, headerEnd + IV_LENGTH)
    const authTag = payload.subarray(headerEnd + IV_LENGTH, headerEnd + IV_LENGTH + AUTH_TAG_LENGTH)
    const ciphertext = payload.subarray(headerEnd + IV_LENGTH + AUTH_TAG_LENGTH)

    try {
      const decipher = createDecipheriv(ALGORITHM, key, iv, {
        authTagLength: AUTH_TAG_LENGTH
      })
      decipher.setAuthTag(authTag)
      return Buffer.concat([decipher.update(ciphertext), decipher.final()])
    } catch {
      throw new PayloadProtectionError(
        'Decryption failed. The data may have been tampered with or the encryptionKey is incorrect.'
      )
    }
  }

  // ── Signing (HMAC-SHA256) ─────────────────────────────────────────────

  private sign(payload: Buffer, key: Buffer): Buffer {
    const hmac = createHmac('sha256', key).update(payload).digest()
    return Buffer.concat([MAGIC_SIGNED, hmac, payload])
  }

  private verify(payload: Buffer, key: Buffer): Buffer {
    const headerEnd = MAGIC_SIGNED.length
    const receivedHmac = payload.subarray(headerEnd, headerEnd + HMAC_LENGTH)
    const data = payload.subarray(headerEnd + HMAC_LENGTH)
    const expectedHmac = createHmac('sha256', key).update(data).digest()

    if (receivedHmac.length !== HMAC_LENGTH || !timingSafeEqual(receivedHmac, expectedHmac)) {
      throw new PayloadProtectionError(
        'HMAC verification failed. The data may have been tampered with or the signingKey is incorrect.'
      )
    }

    return data
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  private startsWith(buffer: Buffer, prefix: Buffer): boolean {
    if (buffer.length < prefix.length) {
      return false
    }
    return buffer.subarray(0, prefix.length).equals(prefix)
  }
}

/**
 * Error thrown when payload protection operations (encrypt/decrypt/sign/verify) fail.
 * Extending `Error` rather than throwing plain strings ensures callers can use
 * `instanceof` checks to distinguish protection errors from other failures.
 */
export class PayloadProtectionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PayloadProtectionError'
  }
}
