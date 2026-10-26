/**
 * Device storage adapters (docs/05 section 3).
 *
 * - `createDeviceBlobStorage` persists connections, organization, prefs, drafts,
 *   outbox and unfinished agent setups as one JSON blob in AsyncStorage under
 *   `DEVICE_STORAGE_KEY`, sealed with AES-GCM (`sealed-storage.ts`). The AES key
 *   lives in SecureStore as `BLOB_KEY_NAME`, readable only while the phone is
 *   unlocked and never restored onto another device.
 * - `secureSecretStore` persists auth secrets only (token/cookie/mode), one entry per
 *   key, in expo-secure-store. Callers build keys with `secretKey`, matching the
 *   `ergates.<connectionId>.<token|cookie|mode>` names `RealGateway` already uses
 *   (src/gateway/real/real-gateway.ts).
 * - `clearPlatformCookieJar` empties the platform cookie jar, where older builds
 *   left Hermes cookies.
 *
 * `expo-secure-store`, `expo-crypto` and `@react-native-cookies/cookies` are
 * loaded lazily (dynamic import inside each method) rather than imported at
 * module scope: they pull in react-native, which a plain Node/vitest run cannot
 * parse. Loading them only when a method
 * actually runs keeps this module, and anything that imports it like
 * device-store.ts, safe to import in Node tests. AsyncStorage has no such issue
 * and is imported normally.
 */
import AsyncStorage from '@react-native-async-storage/async-storage'
import type { AESEncryptionKey } from 'expo-crypto'
import { createJSONStorage, type PersistStorage, type StateStorage } from 'zustand/middleware'

import { createAuthSecretStore, type AuthSecretStore, type SecretStore } from '@/gateway/secrets'

import { createSealedStateStorage, type BlobCipher } from './sealed-storage'

export { MemorySecretStore } from '@/gateway/secrets'

export const DEVICE_STORAGE_KEY = 'ergates-device-v1'

/** The SecureStore entry that holds the device blob's AES key (base64). */
export const BLOB_KEY_NAME = 'ergates.device-blob-key'

/** The three SecureStore entries a connection owns; RealGateway reads/writes the same names (`ergates.<connectionId>.<kind>`). */
export function secretKey(connectionId: string, kind: 'token' | 'cookie' | 'mode'): string {
  return `ergates.${connectionId}.${kind}`
}

/** Zustand `persist` storage whose one value is sealed by `cipher` before it reaches `inner`. */
export function createSealedStorageJson<S>(inner: StateStorage, cipher: BlobCipher, onError?: (error: unknown) => void): PersistStorage<S> {
  const storage = createJSONStorage<S>(() => createSealedStateStorage(inner, cipher, { onError }))
  if (!storage) {
    throw new Error('Failed to create the sealed persist storage.')
  }
  return storage
}

/** The device blob's storage on the phone: AsyncStorage, sealed with AES-GCM. Safe at module scope: nothing is read or created before hydration. */
export function createDeviceBlobStorage<S>(): PersistStorage<S> {
  return createSealedStorageJson<S>(AsyncStorage, createAesBlobCipher(), reportBlobError)
}

function reportBlobError(error: unknown): void {
  // The error class only: a message could quote stored text.
  console.warn(`ergates: device storage failed (${error instanceof Error ? error.name : typeof error})`)
}

/**
 * AES-256-GCM from expo-crypto; the key is created on the first seal and kept in
 * SecureStore with `WHEN_UNLOCKED_THIS_DEVICE_ONLY`. Once read, the key stays in
 * memory, so a write while the phone is locked still seals. Key lookups run one
 * at a time, so two first writes never create two keys.
 */
export function createAesBlobCipher(): BlobCipher {
  let key: AESEncryptionKey | null = null
  let turn: Promise<unknown> = Promise.resolve()

  async function keyStoreOptions() {
    const SecureStore = await import('expo-secure-store')
    return { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY }
  }

  async function loadKey(create: boolean): Promise<AESEncryptionKey | null> {
    if (key) {
      return key
    }
    const SecureStore = await import('expo-secure-store')
    const { AESEncryptionKey, AESKeySize } = await import('expo-crypto')
    const stored = await SecureStore.getItemAsync(BLOB_KEY_NAME, await keyStoreOptions())
    if (stored !== null) {
      key = await AESEncryptionKey.import(stored, 'base64')
    } else if (create) {
      const fresh = await AESEncryptionKey.generate(AESKeySize.AES256)
      await SecureStore.setItemAsync(BLOB_KEY_NAME, await fresh.encoded('base64'), await keyStoreOptions())
      key = fresh
    }
    return key
  }

  function withKey<T>(create: boolean, use: (current: AESEncryptionKey | null) => Promise<T>): Promise<T> {
    const run = turn.then(async () => use(await loadKey(create)))
    turn = run.catch(() => undefined)
    return run
  }

  return {
    seal: plaintext =>
      withKey(true, async current => {
        if (!current) {
          throw new Error('The device blob key could not be created.')
        }
        const { aesEncryptAsync } = await import('expo-crypto')
        const sealed = await aesEncryptAsync(new TextEncoder().encode(plaintext), current)
        return sealed.combined('base64')
      }),
    open: sealed =>
      withKey(false, async current => {
        if (!current) {
          return null
        }
        const { aesDecryptAsync, AESSealedData } = await import('expo-crypto')
        const bytes = await aesDecryptAsync(AESSealedData.fromCombined(base64Bytes(sealed)), current)
        return new TextDecoder().decode(bytes)
      })
  }
}

/**
 * The bytes of base64 text. expo-crypto 57 declares `fromCombined` for base64 text too, but its Android
 * module takes only bytes (`combined: ByteArray`, AesCryptoModule.kt): text there throws, and every start
 * found the device blob unreadable.
 */
function base64Bytes(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

/** SecureStore-backed SecretStore. `key` is the full `ergates.<connectionId>.<kind>` string. */
export const secureSecretStore: SecretStore = {
  async get(key) {
    const SecureStore = await import('expo-secure-store')
    return SecureStore.getItemAsync(key)
  },
  async set(key, value) {
    const SecureStore = await import('expo-secure-store')
    await SecureStore.setItemAsync(key, value)
  },
  async remove(key) {
    const SecureStore = await import('expo-secure-store')
    await SecureStore.deleteItemAsync(key)
  }
}

/**
 * The sign-in store the app uses: SecureStore, unless `useMemoryOnly()` was called
 * at start-up (rooted or jailbroken phone). Shared so the gateway and the device
 * store switch together.
 */
export const authSecretStore: AuthSecretStore = createAuthSecretStore(secureSecretStore)

/** The slice of `@react-native-cookies/cookies` the start-up clear uses. */
interface PlatformCookieJar {
  clearAll(useWebKit?: boolean): Promise<boolean>
  flush?(): Promise<void>
}

/**
 * Empties the platform cookie jar. Older builds let it keep the Hermes session
 * cookies; Ergates no longer reads it (`credentials: 'omit'` in
 * src/gateway/real/http.ts), so on a rooted or jailbroken phone it all goes.
 * Rejects when the native module is missing; the caller treats that as done.
 */
export async function clearPlatformCookieJar(): Promise<void> {
  const imported = (await import('@react-native-cookies/cookies')) as unknown as { default?: PlatformCookieJar } & Partial<PlatformCookieJar>
  const jar = (imported.default ?? imported) as PlatformCookieJar
  await jar.clearAll()
  // Writes the empty jar to disk on Android; does nothing on iOS.
  await jar.flush?.()
}

/** In-memory `StateStorage` for tests; never touches AsyncStorage. */
export function createMemoryStateStorage(): StateStorage {
  const map = new Map<string, string>()
  return {
    getItem: async key => map.get(key) ?? null,
    setItem: async (key, value) => {
      map.set(key, value)
    },
    removeItem: async key => {
      map.delete(key)
    }
  }
}

/** In-memory `persist` storage with the same JSON shape as the device blob, unsealed, for tests. */
export function createMemoryStorageJson<S>(): PersistStorage<S> {
  const storage = createJSONStorage<S>(() => createMemoryStateStorage())
  if (!storage) {
    throw new Error('Failed to create the in-memory persist storage.')
  }
  return storage
}
