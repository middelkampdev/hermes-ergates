/**
 * What the server says about the Ergates plugin, as one value every screen
 * and hook reads: ready, waiting for a restart of Hermes, missing (and whether
 * one tap can install it), disabled, not loaded, outdated, newer than this
 * app, or not answering. A ready or outdated plugin also carries the update
 * this build offers for it, if any.
 * Pure logic over the gateway port, so Node tests drive it with FakeGateway.
 */

import { isGatewayError } from '@/gateway/errors'
import type { GatewayPort } from '@/gateway/port'
import type { ErgatesHealth, HermesPluginRow, PluginProbe } from '@/gateway/types'

import { PLUGIN_NAME, type BuildRecord } from './build-record'
import { hermesFit, type HermesFit } from './hermes-version'
import { updateOffer, type UpdateOffer } from './plugin-version'

export type InstallKind = 'deployment' | 'git install' | 'manual copy'

export type ServerCheck =
  /** `update` is what this build would put on the server; `hermesVersion` is read only when there is one, else null. */
  | { kind: 'ready'; health: ErgatesHealth; update: UpdateOffer | null; hermesVersion: string | null }
  /** The files on the server changed under a running Hermes: the plugin answers with its old code until Hermes restarts. */
  | { kind: 'restart_needed'; health: ErgatesHealth; hermesVersion: string | null }
  /** `oneTap` is true only on a Hermes in the tested range with a commit to install; `reason` then is null. */
  | { kind: 'missing'; hermesVersion: string | null; oneTap: boolean; reason: Exclude<HermesFit, 'in_range'> | 'no_commit' | null }
  | { kind: 'disabled'; hermesVersion: string | null }
  | { kind: 'not_loaded'; hermesVersion: string | null }
  | { kind: 'outdated'; health: ErgatesHealth; installKind: InstallKind; update: UpdateOffer | null; hermesVersion: string | null }
  | { kind: 'app_outdated'; health: ErgatesHealth }
  /** The plugin answered 503, for example when it cannot reach its store; `message` is the server's own safe text. */
  | { kind: 'unavailable'; message: string }
  /** The server did not say (network, timeout, a 5xx): features behave as they did without a check. */
  | { kind: 'unknown' }

export type PluginFit = 'fits' | 'plugin_too_old' | 'app_too_old'

/** How often a screen that waits for the server asks again. */
const POLL_MS = 5_000

/** Whether a failed call was the server refusing the session: the user has to sign in again. */
export function isSignedOut(error: unknown): boolean {
  return isGatewayError(error) && error.kind === 'unauthorized'
}

/**
 * The time to the next check of a screen that waits for the server, or false
 * for none. A refused session stops it: every call fails until the user signs
 * in again.
 */
export function pollInterval(poll: boolean, error: unknown): number | false {
  return poll && !isSignedOut(error) ? POLL_MS : false
}

/**
 * Whether the plugin's health fits an app at `appLevel`. A plugin that reports
 * no `api_level` is older than the field and counts as level 0.
 */
export function pluginFits(health: ErgatesHealth, appLevel: number): PluginFit {
  if (appLevel > (health.api_level ?? 0) || health.store?.writable === false) {
    return 'plugin_too_old'
  }
  if (health.min_api_level !== undefined && appLevel < health.min_api_level) {
    return 'app_too_old'
  }
  return 'fits'
}

/** Hermes's version as `status` reports it, or null when `status` fails: a failed read never stops the check. */
async function hermesVersionOf(port: GatewayPort): Promise<string | null> {
  try {
    return (await port.status()).version
  } catch {
    return null
  }
}

/** The plugin's own row in Hermes's plugin list. A failed list counts as no row; a 401 is the caller's to handle. */
export async function hubRow(port: GatewayPort): Promise<HermesPluginRow | undefined> {
  try {
    return (await port.plugins.hub()).find(row => row.name === PLUGIN_NAME)
  } catch (error) {
    if (isGatewayError(error) && error.kind === 'unauthorized') {
      throw error
    }
    return undefined
  }
}

async function outdated(port: GatewayPort, health: ErgatesHealth, build: BuildRecord | null): Promise<ServerCheck> {
  // A plugin that reports no install is older than the field: someone copied it by hand.
  return { kind: 'outdated', health, installKind: health.install?.kind ?? 'manual copy', update: updateOffer(health, build, 'required'), hermesVersion: await hermesVersionOf(port) }
}

async function ready(port: GatewayPort, health: ErgatesHealth, build: BuildRecord | null): Promise<ServerCheck> {
  const update = updateOffer(health, build, 'optional')
  return { kind: 'ready', health, update, hermesVersion: update === null ? null : await hermesVersionOf(port) }
}

/**
 * Whether the files of a git install changed under the running code: the
 * install record names another commit than the one the answering code was
 * loaded from. A plugin from before it reported the loaded commit says
 * nothing, so it counts when the record already names this build's commit,
 * which only a reinstall by this app or by hand puts there. A plugin that
 * reports no loaded commit for a git install could not read one: that is not
 * a restart to ask for.
 */
function waitsForRestart(health: ErgatesHealth, build: BuildRecord | null): boolean {
  const { install } = health
  if (install?.kind !== 'git install' || !install.commit) {
    return false
  }
  if (install.loaded_commit === undefined) {
    return install.commit === build?.requiredPlugin.commit
  }
  return install.loaded_commit !== null && install.loaded_commit !== install.commit
}

async function missing(port: GatewayPort, build: BuildRecord | null): Promise<ServerCheck> {
  const hermesVersion = await hermesVersionOf(port)
  if (build === null || build.requiredPlugin.commit === null) {
    return { kind: 'missing', hermesVersion, oneTap: false, reason: 'no_commit' }
  }
  const fit = hermesFit(hermesVersion ?? undefined, build.hermesRange)
  return fit === 'in_range' ? { kind: 'missing', hermesVersion, oneTap: true, reason: null } : { kind: 'missing', hermesVersion, oneTap: false, reason: fit }
}

/** Without a build record there is no API level to compare: only the store can show that the plugin is behind. */
function fitOf(health: ErgatesHealth, build: BuildRecord | null): PluginFit {
  if (build !== null) {
    return pluginFits(health, build.requiredPlugin.apiLevel)
  }
  return health.store?.writable === false ? 'plugin_too_old' : 'fits'
}

/**
 * Asks the server about the plugin once. Rejects only with the `unauthorized`
 * `GatewayError` (the caller sends the user to sign in); every other failure
 * of the health read becomes a value. Without a build record an answered
 * plugin is outdated only when its store is not writable, and a missing one
 * gets no one-tap install.
 */
export async function checkServer(port: GatewayPort, build: BuildRecord | null): Promise<ServerCheck> {
  let probe: PluginProbe
  try {
    probe = await port.ergates.health()
  } catch (error) {
    if (isGatewayError(error) && error.kind === 'unauthorized') {
      throw error
    }
    return isGatewayError(error) && error.code === 'store_unavailable' ? { kind: 'unavailable', message: error.message } : { kind: 'unknown' }
  }

  if (probe.state === 'answered') {
    const { health } = probe
    // Before the fit: the code that answers is the old one, whatever the files on the server now say.
    if (waitsForRestart(health, build)) {
      return { kind: 'restart_needed', health, hermesVersion: await hermesVersionOf(port) }
    }
    const fit = fitOf(health, build)
    if (fit === 'app_too_old') {
      return { kind: 'app_outdated', health }
    }
    return fit === 'plugin_too_old' ? outdated(port, health, build) : ready(port, health, build)
  }

  // A 404 that is not worded as "plugin not found" reads as not mounted, but the plugin may not be there at all: the hub list says whether it is.
  const row = await hubRow(port)
  if (row === undefined) {
    return missing(port, build)
  }
  // The hub lists it as enabled although the health read did not find it: it was enabled in between, and its routes are not mounted yet.
  const enabled = probe.state === 'not_loaded' || row.runtime_status === 'enabled'
  return { kind: enabled ? 'not_loaded' : 'disabled', hermesVersion: await hermesVersionOf(port) }
}
