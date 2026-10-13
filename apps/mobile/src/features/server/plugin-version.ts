/**
 * The rules for replacing the plugin on a server with the one this build
 * carries: how two plugin versions compare, when the app offers the update,
 * and whether a connection updates by itself. Pure: the server check reads
 * them, the update run and the screens act on them.
 */

import type { ErgatesHealth } from '@/gateway/types'
import type { Connection } from '@/state/device-store'

import { COMMIT_PATTERN, type BuildRecord } from './build-record'
import { parseHermesVersion } from './hermes-version'

/** The plugin this build would put on the server in place of the one it has. */
export interface UpdateOffer {
  /** The installed plugin's version. */
  from: string
  /** The version this build carries. */
  to: string
  /** The commit this build installs. */
  commit: string
  /** The commit the server has now: where going back leads. */
  previous: string
  /** The store schema the plugin on the server writes, or null when it does not say. */
  previousSchema: number | null
}

/** Orders two `X.Y.Z` versions (a plugin version has the shape of a Hermes version) by their numbers; null when either is anything else (`0.3.0-rc.1`, a blank). */
export function compareVersions(a: string, b: string): -1 | 0 | 1 | null {
  const left = parseHermesVersion(a)
  const right = parseHermesVersion(b)
  if (left === null || right === null) {
    return null
  }
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) {
      return left[i] < right[i] ? -1 : 1
    }
  }
  return 0
}

/**
 * The update this build offers for the plugin a health read describes, or
 * null. Only a git install with a known commit can be replaced and put back.
 * A deployment, a manual copy and a plugin that reports no install belong to
 * whoever put them there, and an install from the Hermes catalog is updated
 * through the catalog, not from here. The recorded commit becomes the commit
 * that going back installs, so it must be a full lower-case hash. Nothing is
 * offered when the build has no commit, is at the installed commit, or when
 * either version cannot be read. A plugin with a higher version is never
 * replaced, so a phone with an older app never undoes a newer one. `need` is
 * `required` when the plugin cannot serve this app (its API level or store)
 * and `optional` when it works. An equal version is replaced only when the
 * update is `required`: for a working plugin it would let two phones on
 * different builds of one version swap the server back and forth.
 */
export function updateOffer(health: ErgatesHealth, build: BuildRecord | null, need: 'optional' | 'required'): UpdateOffer | null {
  const { install } = health
  if (build === null || build.requiredPlugin.commit === null || install?.kind !== 'git install' || (install.catalog_name ?? null) !== null) {
    return null
  }
  const previous: unknown = install.commit
  const { version, commit } = build.requiredPlugin
  if (typeof previous !== 'string' || !COMMIT_PATTERN.test(previous) || previous === commit) {
    return null
  }
  const order = compareVersions(health.plugin_version, version)
  if (order === null || order === 1 || (order === 0 && need === 'optional')) {
    return null
  }
  return { from: health.plugin_version, to: version, commit, previous, previousSchema: health.store?.plugin_schema_version ?? null }
}

/** Whether the connection keeps its server plugin up to date by itself: on until the user turns it off. */
export function autoUpdate(connection: Connection): boolean {
  return connection.autoUpdatePlugin !== false
}
