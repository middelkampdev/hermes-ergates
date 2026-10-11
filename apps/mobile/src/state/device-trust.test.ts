/**
 * Root and jailbreak detection, with the probe faked: expo-device pulls in
 * react-native, which a plain Node run cannot parse.
 */
import { describe, expect, it, vi } from 'vitest'

import { detectDeviceTrust } from './device-trust'

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
