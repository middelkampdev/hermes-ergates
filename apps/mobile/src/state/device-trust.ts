/**
 * Whether this phone is rooted (Android) or jailbroken (iOS).
 *
 * The check is a heuristic for honest users. It does not stop an attacker who
 * hides root, and it never blocks the app: a phone that is not flagged, or whose
 * check fails, counts as standard.
 *
 * Two checks run side by side. expo-device's `isRootedExperimentalAsync` sees
 * `su` in /system/xbin and rootful-era jailbreaks only. The app's own
 * root-traces module (modules/root-traces) also looks for the files a rootless
 * jailbreak (Dopamine, palera1n: everything under /var/jb) or a common Android
 * `su` install leaves behind. Either one is enough to flag the phone.
 *
 * `detectDeviceTrust` takes a `TrustProbe` so Node tests can fake the device.
 * `expoTrustProbe` builds the real one. `expo-device` and the root-traces module
 * are loaded lazily (dynamic import inside the function) rather than at module
 * scope, for the same reason persistence.ts loads expo-secure-store that way:
 * they pull in react-native, which a plain Node/vitest run cannot parse.
 */
import type { AuthSecretStore, SecretStore } from '@/gateway/secrets'

import { secretKey } from './persistence'

export type DeviceTrust = 'standard' | 'rooted'

export interface TrustProbe {
  /** `true` on a physical phone, `false` on a simulator or emulator, `null` when unknown. */
  isDevice: boolean | null
  /** The platform's root or jailbreak check. May reject. */
  isRooted(): Promise<boolean>
  /** The root or jailbreak files found on this phone; empty when none. May reject. */
  findRootTraces(): Promise<string[]>
  /** Development only: report `rooted` without asking the check, so the rooted path can be tried on a simulator. */
  forceRooted: boolean
}

/** How long start-up waits for a native call here; the spinner stays up until it answers. */
const NATIVE_CALL_LIMIT_MS = 2_000

/** `work`'s value, or `fallback` once `ms` pass without an answer. */
async function within<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<T>(resolve => {
    timer = setTimeout(() => resolve(fallback), ms)
  })
  try {
    return await Promise.race([work, late])
  } finally {
    clearTimeout(timer)
  }
}

/** `work`'s value, or `fallback` when it throws or has not answered within the native call limit. */
async function settle<T>(work: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await within(Promise.resolve().then(work), NATIVE_CALL_LIMIT_MS, fallback)
  } catch {
    return fallback
  }
}

/**
 * Simulators and emulators are always standard (their root signals say nothing
 * about a user's phone) unless the dev flag forces the rooted path. An unknown
 * device kind counts as a simulator. On a phone both checks run at once, each
 * with its own two-second limit, and either one flags it. A check that throws,
 * or that has not answered in time, counts as finding nothing, so one broken
 * check never hides what the other found.
 */
export async function detectDeviceTrust(probe: TrustProbe): Promise<DeviceTrust> {
  if (probe.forceRooted) {
    return 'rooted'
  }
  if (probe.isDevice !== true) {
    return 'standard'
  }
  const [rooted, traces] = await Promise.all([settle(() => probe.isRooted(), false), settle(() => probe.findRootTraces(), [] as string[])])
  return rooted || traces.length > 0 ? 'rooted' : 'standard'
}

/** The part of the root-traces native module this file uses. */
export interface RootTracesModule {
  findRootTracesAsync(): Promise<string[]>
}

/**
 * The trace search backed by the native module, or one that finds nothing when
 * the module is missing (a dev client built before the module existed), so
 * start-up never breaks on an old build.
 */
export function rootTracesFinder(module: RootTracesModule | null): () => Promise<string[]> {
  return module ? () => module.findRootTracesAsync() : async () => []
}

/**
 * The probe backed by expo-device and the root-traces module.
 * `EXPO_PUBLIC_DEV_FORCE_ROOTED=1` is inlined at bundle time and read only while
 * `__DEV__` is true, so a release bundle never honors it.
 */
export async function expoTrustProbe(): Promise<TrustProbe> {
  const Device = await import('expo-device')
  const { default: rootTraces } = await import('../../modules/root-traces/src/RootTracesModule')
  return {
    isDevice: Device.isDevice,
    isRooted: () => Device.isRootedExperimentalAsync(),
    findRootTraces: rootTracesFinder(rootTraces),
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
 *
 * `clearPlatformCookies` then empties the platform cookie jar, where a phone that
 * ran an older build in password mode still keeps the Hermes cookies, the 30-day
 * refresh cookie included. Nothing in the app reads the jar any more (requests
 * send `credentials: 'omit'`, the chat socket signs in with a ticket), so all of
 * it can go. Also best effort: a failure, or no answer within two seconds, does
 * not change the result.
 */
export async function initDeviceTrust(
  store: AuthSecretStore,
  persistent: SecretStore,
  connectionIds: string[],
  probe: TrustProbe,
  clearPlatformCookies?: () => Promise<void>
): Promise<DeviceTrust> {
  const trust = await detectDeviceTrust(probe)
  settledTrust = trust
  if (trust === 'rooted') {
    store.useMemoryOnly()
    const keys = connectionIds.flatMap(id => (['token', 'cookie', 'mode'] as const).map(kind => secretKey(id, kind)))
    await Promise.allSettled(keys.map(key => persistent.remove(key)))
    if (clearPlatformCookies) {
      await within(
        Promise.resolve()
          .then(clearPlatformCookies)
          .catch(() => undefined),
        NATIVE_CALL_LIMIT_MS,
        undefined
      )
    }
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
  buildProbe: () => Promise<TrustProbe>,
  clearPlatformCookies?: () => Promise<void>
): Promise<DeviceTrust> {
  try {
    return await initDeviceTrust(store, persistent, connectionIds, await buildProbe(), clearPlatformCookies)
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

/** Why the Sign-in screen asks again on a flagged phone. iOS says jailbroken, Android says rooted. */
export function rootedReasonLine(platform: string): string {
  return `Ergates does not keep your sign-in on a ${platform === 'ios' ? 'jailbroken' : 'rooted'} phone.`
}
