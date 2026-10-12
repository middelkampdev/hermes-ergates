/**
 * What this build of the app needs from the Hermes server: the Ergates plugin
 * (its version, its API level and the commit to install) and the Hermes
 * versions CI has tested. app.config.ts writes it into the app's config at
 * build time; `parseBuildRecord` reads it back and trusts nothing it cannot
 * check. The app installs only this plugin, at this commit: nothing a server,
 * an agent or a message says changes either.
 */

/** The one source the app installs the plugin from (a folder of the Ergates repository). */
export const PLUGIN_IDENTIFIER = 'middelkampdev/hermes-ergates/integrations/ergates'
export const PLUGIN_NAME = 'ergates'

export interface RequiredPlugin {
  version: string
  apiLevel: number
  /** The commit of this build, or null when the build had no git checkout (the app then offers only the guide). */
  commit: string | null
}

export interface HermesRange {
  /** The oldest Hermes version the plugin supports, `X.Y.Z`. */
  oldest: string
  /** The newest Hermes minor CI has tested, `X.Y`. */
  newestMinor: string
}

export interface BuildRecord {
  requiredPlugin: RequiredPlugin
  hermesRange: HermesRange
}

const VERSION = /^\d+\.\d+\.\d+$/
const MINOR = /^\d+\.\d+$/
const COMMIT = /^[0-9a-f]{40}$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function matching(value: unknown, pattern: RegExp): string | null {
  return typeof value === 'string' && pattern.test(value) ? value : null
}

/**
 * The build record in `extra` (the app's `extra` config, where app.config.ts
 * puts it under `ergates`), or null when it is missing or malformed. A commit
 * that is not 40 lower-case hex digits becomes null; the rest of the record
 * must be valid.
 */
export function parseBuildRecord(extra: unknown): BuildRecord | null {
  if (!isRecord(extra) || !isRecord(extra.ergates)) {
    return null
  }
  const { requiredPlugin, hermesRange } = extra.ergates
  if (!isRecord(requiredPlugin) || !isRecord(hermesRange)) {
    return null
  }
  const version = matching(requiredPlugin.version, VERSION)
  const oldest = matching(hermesRange.oldest, VERSION)
  const newestMinor = matching(hermesRange.newestMinor, MINOR)
  const { apiLevel } = requiredPlugin
  if (version === null || oldest === null || newestMinor === null || typeof apiLevel !== 'number' || !Number.isInteger(apiLevel) || apiLevel < 1) {
    return null
  }
  return {
    requiredPlugin: { version, apiLevel, commit: matching(requiredPlugin.commit, COMMIT) },
    hermesRange: { oldest, newestMinor }
  }
}
