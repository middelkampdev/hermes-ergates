/**
 * The one place that reads the build record out of the app's config. Only
 * screens import it; the rules that use the record live in the server feature
 * and take it as an argument, so they run unchanged in Node.
 */
import Constants from 'expo-constants'

import { parseBuildRecord, type BuildRecord } from '@/features/server'

/** The plugin and Hermes range this build needs, or null when the config carries no valid record. */
export function buildRecord(): BuildRecord | null {
  return parseBuildRecord(Constants.expoConfig?.extra)
}
