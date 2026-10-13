/// <reference types="node" />
/**
 * The app's dynamic config. app.json stays the base; this adds
 * `extra.ergates`, the build record (src/features/server/build-record.ts):
 * the Ergates plugin this build needs (version and API level from the plugin's
 * own files, and the commit of this checkout) and the Hermes versions CI has
 * tested. The app reads it back with `Constants.expoConfig.extra`.
 *
 * Expo runs this file itself, at prebuild and again in the native build, so
 * the logic stays in this one file: a second TypeScript module would need
 * Expo's loader to follow the import. The release scripts rewrite app.json
 * (the build number) before the build; Expo passes that file as `config`.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import type { ConfigContext, ExpoConfig } from 'expo/config'

import type { BuildRecord } from './src/features/server'

/** The repository root, two folders above apps/mobile. */
const ROOT = path.resolve(__dirname, '../..')

function readRepoFile(repoRoot: string, relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8')
}

function firstGroup(text: string, pattern: RegExp, source: string, what: string): string {
  const found = text.match(pattern)
  if (!found) {
    throw new Error(`app.config.ts: ${source} has no ${what}.`)
  }
  return found[1]
}

/** `[major, minor]` of an `X.Y` or `X.Y.Z` version. */
function minorOf(version: string): [number, number] {
  const [major, minor] = version.split('.').map(Number)
  return [major, minor]
}

/**
 * The build record for the plugin in `repoRoot`: its version (plugin.yaml),
 * its API level (the plugin's __init__.py) and the Hermes floor it declares
 * (`requires_hermes`). `testedThrough` is the newest Hermes minor CI has
 * tested (`expo.extra.hermesTestedThrough` in app.json); it cannot be older
 * than the minor of the floor.
 */
export function readBuildRecord(repoRoot: string, testedThrough: string, commit: string | null): BuildRecord {
  if (!/^\d+\.\d+$/.test(String(testedThrough))) {
    throw new Error(`app.config.ts: expo.extra.hermesTestedThrough in app.json must be a Hermes minor like "0.21" (X.Y), got ${JSON.stringify(testedThrough)}.`)
  }
  const pluginYaml = readRepoFile(repoRoot, 'integrations/ergates/plugin.yaml')
  const version = firstGroup(pluginYaml, /^version: (\d+\.\d+\.\d+)$/m, 'integrations/ergates/plugin.yaml', 'version line (version: X.Y.Z)')
  const oldest = firstGroup(pluginYaml, /^requires_hermes: "?>=(\d+\.\d+\.\d+)"?$/m, 'integrations/ergates/plugin.yaml', 'requires_hermes floor (">=X.Y.Z")')
  const apiLevel = Number(firstGroup(readRepoFile(repoRoot, 'integrations/ergates/ergates/__init__.py'), /^API_LEVEL = (\d+)$/m, 'integrations/ergates/ergates/__init__.py', 'API_LEVEL line'))

  const [floorMajor, floorMinor] = minorOf(oldest)
  const [testedMajor, testedMinor] = minorOf(testedThrough)
  if (testedMajor < floorMajor || (testedMajor === floorMajor && testedMinor < floorMinor)) {
    throw new Error(`app.config.ts: hermesTestedThrough ${testedThrough} is below the minor of the oldest Hermes the plugin supports (${oldest}). Raise it in app.json.`)
  }
  return { requiredPlugin: { version, apiLevel, commit }, hermesRange: { oldest, newestMinor: testedThrough } }
}

const FULL_COMMIT = /^[0-9a-f]{40}$/

/**
 * The commit the plugin installs from: ERGATES_PLUGIN_COMMIT when set (the
 * release workflows set it to the tag's commit, and a developer may), else
 * the HEAD of the checkout. Null when there is no git or no repository. A
 * value that is not a full commit fails the build: the app would otherwise
 * ship without a commit, and so without one-tap setup, and say nothing.
 */
function pluginCommit(repoRoot: string): string | null {
  const fromEnv = process.env.ERGATES_PLUGIN_COMMIT?.trim()
  if (fromEnv) {
    if (!FULL_COMMIT.test(fromEnv)) {
      throw new Error(`app.config.ts: ERGATES_PLUGIN_COMMIT must be a full commit of 40 lowercase hex characters, got ${JSON.stringify(fromEnv)}. Unset it to take the commit from git.`)
    }
    return fromEnv
  }
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return null
  }
}

export default ({ config }: ConfigContext): Partial<ExpoConfig> => ({
  ...config,
  extra: {
    ...config.extra,
    ergates: readBuildRecord(ROOT, config.extra?.hermesTestedThrough, pluginCommit(ROOT))
  }
})
