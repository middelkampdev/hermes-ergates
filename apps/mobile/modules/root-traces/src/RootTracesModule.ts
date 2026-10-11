import { NativeModule, requireOptionalNativeModule } from 'expo'

declare class RootTracesModule extends NativeModule {
  /** The root or jailbreak files that exist on this phone; empty when none. */
  findRootTracesAsync(): Promise<string[]>
}

/**
 * `null` when the running build has no native side for this module (a dev
 * client built before it existed, or the web), so callers can fall back
 * instead of failing at start-up.
 */
export default requireOptionalNativeModule<RootTracesModule>('RootTraces')
