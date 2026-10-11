/**
 * Root and jailbreak detection, with the probe faked: expo-device pulls in
 * react-native, which a plain Node run cannot parse.
 */
import { describe, expect, it, vi } from 'vitest'

import { createAuthSecretStore, MemorySecretStore, type SecretStore } from '@/gateway/secrets'

import { currentDeviceTrust, detectDeviceTrust, initDeviceTrust, rootedNoticeCopy, startDeviceTrust, type TrustProbe } from './device-trust'
import { secretKey } from './persistence'

describe('detectDeviceTrust', () => {
  it('counts a simulator as standard without asking the root check', async () => {
    const isRooted = vi.fn()

    await expect(detectDeviceTrust({ isDevice: false, isRooted, forceRooted: false })).resolves.toBe('standard')

    expect(isRooted).not.toHaveBeenCalled()
  })

  it('counts an unknown device kind as a simulator', async () => {
    const isRooted = vi.fn()

    await expect(detectDeviceTrust({ isDevice: null, isRooted, forceRooted: false })).resolves.toBe('standard')

    expect(isRooted).not.toHaveBeenCalled()
  })

  it('reports a physical device the root check flags', async () => {
    await expect(detectDeviceTrust({ isDevice: true, isRooted: async () => true, forceRooted: false })).resolves.toBe('rooted')
  })

  it('reports a clean physical device as standard', async () => {
    await expect(detectDeviceTrust({ isDevice: true, isRooted: async () => false, forceRooted: false })).resolves.toBe('standard')
  })

  it('treats a failing root check as standard', async () => {
    const isRooted = async () => {
      throw new Error('ERR_DEVICE_ROOT_DETECTION')
    }

    await expect(detectDeviceTrust({ isDevice: true, isRooted, forceRooted: false })).resolves.toBe('standard')
  })

  it('follows the dev flag on a simulator', async () => {
    const isRooted = vi.fn()

    await expect(detectDeviceTrust({ isDevice: false, isRooted, forceRooted: true })).resolves.toBe('rooted')

    expect(isRooted).not.toHaveBeenCalled()
  })
})

const KINDS = ['token', 'cookie', 'mode'] as const
const rootedProbe: TrustProbe = { isDevice: true, isRooted: async () => true, forceRooted: false }
const standardProbe: TrustProbe = { isDevice: true, isRooted: async () => false, forceRooted: false }

/** A persistent store holding a token, a cookie and a mode for each connection id. */
async function signedInStore(...connectionIds: string[]): Promise<MemorySecretStore> {
  const persistent = new MemorySecretStore()
  for (const id of connectionIds) {
    for (const kind of KINDS) {
      await persistent.set(secretKey(id, kind), `${kind}-of-${id}`)
    }
  }
  return persistent
}

describe('initDeviceTrust', () => {
  it('purges every stored sign-in and switches to memory when the phone is rooted', async () => {
    const persistent = await signedInStore('c-1', 'c-2')
    const store = createAuthSecretStore(persistent)

    await expect(initDeviceTrust(store, persistent, ['c-1', 'c-2'], rootedProbe)).resolves.toBe('rooted')

    for (const id of ['c-1', 'c-2']) {
      for (const kind of KINDS) {
        expect(await persistent.get(secretKey(id, kind))).toBeNull()
      }
    }
    expect(store.memoryOnly).toBe(true)
    expect(currentDeviceTrust()).toBe('rooted')
  })

  it('leaves stored sign-ins alone on a standard phone', async () => {
    const persistent = await signedInStore('c-1', 'c-2')
    const store = createAuthSecretStore(persistent)

    await expect(initDeviceTrust(store, persistent, ['c-1', 'c-2'], standardProbe)).resolves.toBe('standard')

    for (const id of ['c-1', 'c-2']) {
      for (const kind of KINDS) {
        expect(await persistent.get(secretKey(id, kind))).toBe(`${kind}-of-${id}`)
      }
    }
    expect(store.memoryOnly).toBe(false)
    expect(currentDeviceTrust()).toBe('standard')
  })

  it('switches to memory even when a stored sign-in cannot be removed', async () => {
    const persistent = await signedInStore('c-1')
    const stubborn: SecretStore = {
      get: key => persistent.get(key),
      set: (key, value) => persistent.set(key, value),
      remove: async key => {
        if (key === secretKey('c-1', 'token')) {
          throw new Error('keychain locked')
        }
        await persistent.remove(key)
      }
    }
    const store = createAuthSecretStore(stubborn)

    await expect(initDeviceTrust(store, stubborn, ['c-1'], rootedProbe)).resolves.toBe('rooted')

    expect(store.memoryOnly).toBe(true)
    expect(currentDeviceTrust()).toBe('rooted')
    expect(await persistent.get(secretKey('c-1', 'cookie'))).toBeNull()
    expect(await persistent.get(secretKey('c-1', 'mode'))).toBeNull()
  })
})

describe('startDeviceTrust', () => {
  it('counts a probe that cannot be built as standard and still resolves', async () => {
    const persistent = await signedInStore('c-1')
    const store = createAuthSecretStore(persistent)
    await initDeviceTrust(createAuthSecretStore(persistent), persistent, [], rootedProbe)

    await expect(
      startDeviceTrust(store, persistent, ['c-1'], async () => {
        throw new Error('native module missing')
      })
    ).resolves.toBe('standard')

    expect(store.memoryOnly).toBe(false)
    expect(currentDeviceTrust()).toBe('standard')
    expect(await persistent.get(secretKey('c-1', 'token'))).toBe('token-of-c-1')
  })

  it('builds the probe and applies it when the module is available', async () => {
    const persistent = await signedInStore('c-1')
    const store = createAuthSecretStore(persistent)

    await expect(startDeviceTrust(store, persistent, ['c-1'], async () => rootedProbe)).resolves.toBe('rooted')

    expect(store.memoryOnly).toBe(true)
    expect(await persistent.get(secretKey('c-1', 'token'))).toBeNull()
  })
})

describe('rootedNoticeCopy', () => {
  const body = 'Apps with root access can read your server sign-in. Ergates does not keep your sign-in on this phone, so you sign in each time the app starts.'

  it('says jailbroken on iOS', () => {
    expect(rootedNoticeCopy('ios')).toEqual({ title: 'This iPhone is jailbroken', body })
  })

  it('says rooted on Android and anywhere else', () => {
    expect(rootedNoticeCopy('android')).toEqual({ title: 'This phone is rooted', body })
    expect(rootedNoticeCopy('web')).toEqual({ title: 'This phone is rooted', body })
  })
})
