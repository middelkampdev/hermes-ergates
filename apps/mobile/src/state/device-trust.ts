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
