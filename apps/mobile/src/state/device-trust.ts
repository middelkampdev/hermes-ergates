/**
 * Whether this phone is rooted (Android) or jailbroken (iOS).
 *
 * The check is a heuristic for honest users. It does not stop an attacker who
 * hides root, and it never blocks the app: a phone that is not flagged, or whose
 * check fails, counts as standard.
 *
 * `detectDeviceTrust` takes a `TrustProbe` so Node tests can fake the device.
 * `expoTrustProbe` builds the real one. `expo-device` is loaded lazily (dynamic
 * import inside the function) rather than at module scope, for the same reason
 * persistence.ts loads expo-secure-store that way: it pulls in react-native,
 * which a plain Node/vitest run cannot parse.
 */
import type { AuthSecretStore, SecretStore } from '@/gateway/secrets'

import { secretKey } from './persistence'

export type DeviceTrust = 'standard' | 'rooted'

export interface TrustProbe {
  /** `true` on a physical phone, `false` on a simulator or emulator, `null` when unknown. */
  isDevice: boolean | null
  /** The platform's root or jailbreak check. May reject. */
  isRooted(): Promise<boolean>
  /** Development only: report `rooted` without asking the check, so the rooted path can be tried on a simulator. */
  forceRooted: boolean
}

/**
 * Simulators and emulators are always standard (their root signals say nothing
 * about a user's phone) unless the dev flag forces the rooted path. An unknown
 * device kind counts as a simulator. A check that throws counts as standard.
 */
export async function detectDeviceTrust(probe: TrustProbe): Promise<DeviceTrust> {
  if (probe.forceRooted) {
    return 'rooted'
  }
  if (probe.isDevice !== true) {
    return 'standard'
  }
  try {
    return (await probe.isRooted()) ? 'rooted' : 'standard'
  } catch {
    return 'standard'
  }
}

/**
 * The probe backed by expo-device. `EXPO_PUBLIC_DEV_FORCE_ROOTED=1` is inlined at
 * bundle time and read only while `__DEV__` is true, so a release bundle never
 * honors it.
 */
export async function expoTrustProbe(): Promise<TrustProbe> {
  const Device = await import('expo-device')
  return {
    isDevice: Device.isDevice,
    isRooted: () => Device.isRootedExperimentalAsync(),
    forceRooted: __DEV__ && process.env.EXPO_PUBLIC_DEV_FORCE_ROOTED === '1'
  }
}

let settledTrust: DeviceTrust = 'standard'

/** What `initDeviceTrust` settled on this run; `standard` until it has run. */
export function currentDeviceTrust(): DeviceTrust {
  return settledTrust
}

/**
 * Runs once at start-up, after the device store has hydrated (so the saved
 * connection ids are known) and before any gateway restores a sign-in. On a
 * rooted or jailbroken phone it switches the sign-in store to memory and removes
 * the token, cookie and mode every saved connection left in `persistent`, so
 * nothing another app could read stays on the phone. Drafts, the outbox and the
 * organization live in the device blob and are not touched.
 *
 * The switch comes first and the purge is best effort: once the store is in
 * memory the leftovers are never read again, so one entry that will not delete
 * must not stop the others or the app from starting.
 */
export async function initDeviceTrust(
  store: AuthSecretStore,
  persistent: SecretStore,
  connectionIds: string[],
  probe: TrustProbe
): Promise<DeviceTrust> {
  const trust = await detectDeviceTrust(probe)
  settledTrust = trust
  if (trust === 'rooted') {
    store.useMemoryOnly()
    const keys = connectionIds.flatMap(id => (['token', 'cookie', 'mode'] as const).map(kind => secretKey(id, kind)))
    await Promise.allSettled(keys.map(key => persistent.remove(key)))
  }
  return trust
}

/**
 * `initDeviceTrust` for the app's start-up: builds the probe too, and counts
 * any failure as standard, so a build without the native module still starts.
 */
export async function startDeviceTrust(
  store: AuthSecretStore,
  persistent: SecretStore,
  connectionIds: string[],
  buildProbe: () => Promise<TrustProbe>
): Promise<DeviceTrust> {
  try {
    return await initDeviceTrust(store, persistent, connectionIds, await buildProbe())
  } catch {
    settledTrust = 'standard'
    return 'standard'
  }
}

/** The one-time notice on a flagged phone. iOS says jailbroken, Android says rooted. */
export function rootedNoticeCopy(platform: string): { title: string; body: string } {
  return {
    title: platform === 'ios' ? 'This iPhone is jailbroken' : 'This phone is rooted',
    body: 'Apps with root access can read your server sign-in. Ergates does not keep your sign-in on this phone, so you sign in each time the app starts.'
  }
}
