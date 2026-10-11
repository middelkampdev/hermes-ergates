/**
 * The AES-GCM blob cipher and the platform cookie jar clear, with expo-crypto,
 * expo-secure-store and the cookie module replaced by Node stand-ins: the native
 * modules cannot load in Node. The stand-in keeps
 * expo-crypto's combined format (12-byte IV, ciphertext, 16-byte tag).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

// vi.mock calls below are hoisted above these imports.
import { BLOB_KEY_NAME, clearPlatformCookieJar, createAesBlobCipher, createDeviceBlobStorage, DEVICE_STORAGE_KEY } from './persistence'
import { SEALED_PREFIX } from './sealed-storage'

/** The raw ciphertext bytes of a stored value, decoded past the sealed prefix and its base64 wrapper. */
function sealedBytes(raw: string): Buffer {
  return Buffer.from(raw.slice(SEALED_PREFIX.length), 'base64')
}

const keychain = vi.hoisted(() => ({
  items: new Map<string, string>(),
  options: [] as unknown[],
  failReads: false
}))

vi.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY',
  getItemAsync: async (name: string, options?: unknown) => {
    keychain.options.push(options)
    if (keychain.failReads) {
      throw new Error('User interaction is not allowed.')
    }
    return keychain.items.get(name) ?? null
  },
  setItemAsync: async (name: string, value: string, options?: unknown) => {
    keychain.options.push(options)
    keychain.items.set(name, value)
  },
  deleteItemAsync: async (name: string) => {
    keychain.items.delete(name)
  }
}))

vi.mock('expo-crypto', async () => {
  const { createCipheriv, createDecipheriv, randomBytes } = await import('node:crypto')

  class AESEncryptionKey {
    constructor(readonly raw: Buffer) {}
    static async generate(size = 256) {
      return new AESEncryptionKey(randomBytes(size / 8))
    }
    static async import(text: string, encoding: 'base64' | 'hex') {
      return new AESEncryptionKey(Buffer.from(text, encoding))
    }
    async encoded(encoding: 'base64' | 'hex') {
      return this.raw.toString(encoding)
    }
  }

  class AESSealedData {
    constructor(readonly bytes: Buffer) {}
    static fromCombined(base64: string) {
      return new AESSealedData(Buffer.from(base64, 'base64'))
    }
    async combined(encoding: 'base64') {
      return this.bytes.toString(encoding)
    }
  }

  return {
    AESKeySize: { AES128: 128, AES192: 192, AES256: 256 },
    AESEncryptionKey,
    AESSealedData,
    aesEncryptAsync: async (plaintext: Uint8Array, key: AESEncryptionKey) => {
      const iv = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', key.raw, iv)
      const body = Buffer.concat([cipher.update(plaintext), cipher.final()])
      return new AESSealedData(Buffer.concat([iv, body, cipher.getAuthTag()]))
    },
    aesDecryptAsync: async (sealed: AESSealedData, key: AESEncryptionKey) => {
      const bytes = sealed.bytes
      const decipher = createDecipheriv('aes-256-gcm', key.raw, bytes.subarray(0, 12))
      decipher.setAuthTag(bytes.subarray(bytes.length - 16))
      return new Uint8Array(Buffer.concat([decipher.update(bytes.subarray(12, bytes.length - 16)), decipher.final()]))
    }
  }
})

const asyncStorage = vi.hoisted(() => new Map<string, string>())

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (name: string) => asyncStorage.get(name) ?? null,
    setItem: async (name: string, value: string) => {
      asyncStorage.set(name, value)
    },
    removeItem: async (name: string) => {
      asyncStorage.delete(name)
    }
  }
}))

const cookieJar = vi.hoisted(() => ({ calls: [] as string[] }))

vi.mock('@react-native-cookies/cookies', () => ({
  default: {
    clearAll: async (useWebKit?: boolean) => {
      cookieJar.calls.push(`clearAll(${String(useWebKit)})`)
      return true
    },
    flush: async () => {
      cookieJar.calls.push('flush')
    }
  }
}))

beforeEach(() => {
  cookieJar.calls.length = 0
  asyncStorage.clear()
  keychain.items.clear()
  keychain.options.length = 0
  keychain.failReads = false
})

describe('the AES-GCM device blob cipher', () => {
  it('round-trips text, and the sealed form holds none of it', async () => {
    const cipher = createAesBlobCipher()
    const text = '{"drafts":{"c1:linh":"the invoice from Dirk ✓"}}'

    const sealed = await cipher.seal(text)

    expect(Buffer.from(sealed, 'base64').toString('utf8')).not.toContain('Dirk')
    expect(await cipher.open(sealed)).toBe(text)
  })

  it('keeps its key in SecureStore, readable only while unlocked and only on this device', async () => {
    await createAesBlobCipher().seal('x')

    expect([...keychain.items.keys()]).toEqual([BLOB_KEY_NAME])
    expect(Buffer.from(keychain.items.get(BLOB_KEY_NAME) as string, 'base64')).toHaveLength(32)
    expect(keychain.options).not.toHaveLength(0)
    expect(keychain.options.every(option => JSON.stringify(option) === '{"keychainAccessible":"WHEN_UNLOCKED_THIS_DEVICE_ONLY"}')).toBe(true)
  })

  it('creates one key for two first writes at the same moment', async () => {
    const cipher = createAesBlobCipher()
    const [a, b] = await Promise.all([cipher.seal('a'), cipher.seal('b')])

    const later = createAesBlobCipher() // a new app launch reads the stored key
    expect(await later.open(a)).toBe('a')
    expect(await later.open(b)).toBe('b')
  })

  it('opens nothing when no key was ever stored, and creates none', async () => {
    expect(await createAesBlobCipher().open('AAAA')).toBeNull()
    expect(keychain.items.size).toBe(0)
  })

  it('rejects when the key store refuses, and reads the key again on the next call', async () => {
    const sealed = await createAesBlobCipher().seal('kept')
    const cipher = createAesBlobCipher()
    keychain.failReads = true

    await expect(cipher.open(sealed)).rejects.toThrow('User interaction is not allowed.')

    keychain.failReads = false
    expect(await cipher.open(sealed)).toBe('kept')
  })

  it('keeps the key in memory once read, so a write while the phone is locked still seals', async () => {
    const cipher = createAesBlobCipher()
    const first = await cipher.seal('before the lock')
    keychain.failReads = true

    const second = await cipher.seal('while locked')

    keychain.failReads = false
    const later = createAesBlobCipher()
    expect(await later.open(first)).toBe('before the lock')
    expect(await later.open(second)).toBe('while locked')
  })

  it('rejects sealed data that was changed', async () => {
    const cipher = createAesBlobCipher()
    const sealed = Buffer.from(await cipher.seal('original'), 'base64')
    sealed[14] ^= 0xff

    await expect(cipher.open(sealed.toString('base64'))).rejects.toThrow()
  })
})

describe('the device blob storage on the phone', () => {
  it('writes the blob to AsyncStorage sealed, and reads it back', async () => {
    const storage = createDeviceBlobStorage<{ drafts: Record<string, string> }>()
    const value = { state: { drafts: { 'c1:linh': 'the invoice from Dirk' } }, version: 1 }

    await storage.setItem(DEVICE_STORAGE_KEY, value)

    const raw = asyncStorage.get(DEVICE_STORAGE_KEY) as string
    expect(raw.startsWith(SEALED_PREFIX)).toBe(true)
    expect(sealedBytes(raw).includes('Dirk')).toBe(false)
    expect(await storage.getItem(DEVICE_STORAGE_KEY)).toEqual(value)
  })

  it('logs only the error class when the blob cannot be opened, never its message', async () => {
    await createDeviceBlobStorage<{ drafts: Record<string, string> }>().setItem(DEVICE_STORAGE_KEY, { state: { drafts: {} }, version: 1 })
    const relaunched = createDeviceBlobStorage<{ drafts: Record<string, string> }>()
    keychain.failReads = true
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    expect(await relaunched.getItem(DEVICE_STORAGE_KEY)).toBeNull()

    expect(warn.mock.calls).toEqual([['ergates: device storage failed (Error)']])
    warn.mockRestore()
  })
})

describe('the platform cookie jar', () => {
  it('empties the whole jar, then writes it to disk', async () => {
    await clearPlatformCookieJar()

    expect(cookieJar.calls).toEqual(['clearAll(undefined)', 'flush'])
  })
})
