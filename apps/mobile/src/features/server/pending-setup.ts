/**
 * The pending setup: a plugin the app put on a server before the plugin's
 * `POST /setup` ran. `Connection.pendingPluginSetup` holds the commit and
 * stays until the setup succeeded, so a closed app, a lost connection or a
 * server restart in between never skips it. Without the flag the app never
 * calls `/setup` on its own: each call enables the plugin in every profile
 * again, which undoes a profile the owner turned off (ADR-042).
 *
 * The runs that put a plugin on a server (setup, update and going back) are
 * tracked here too: a connection has at most one of them going.
 */

import type { GatewayPort } from '@/gateway/port'
import type { SetupState } from '@/gateway/types'
import { useDeviceStore, type Connection } from '@/state/device-store'

import type { ServerCheck } from './server-check'

/** The setup that is going for each connection. */
const finishing = new Map<string, Promise<PendingSetupResult>>()

/** `update` is an update or going back: the same run with another commit. */
export type RunKind = 'setup' | 'update'

/** The runs going, by connection, until each ends. */
const runs = new Map<string, { kind: RunKind; goingBack: boolean }>()

/** Which run is going for the connection, or null. */
export function runningKind(connectionId: string): RunKind | null {
  return runs.get(connectionId)?.kind ?? null
}

/** Whether the run going for the connection is a going back. */
export function isGoingBack(connectionId: string): boolean {
  return runs.get(connectionId)?.goingBack === true
}

/**
 * Whether a run is going for the connection, of any kind: it is true during
 * an update and while going back too. Each of them runs the plugin's setup
 * itself. `runningKind` says which one.
 */
export function isSetupRunning(connectionId: string): boolean {
  return runs.has(connectionId)
}

/** Records that a run is going for the connection until `run` settles. Kept here, not in the run modules, because they import this one. */
export function trackRun(connectionId: string, kind: RunKind, goingBack: boolean, run: Promise<unknown>): void {
  runs.set(connectionId, { kind, goingBack })
  const forget = () => {
    runs.delete(connectionId)
  }
  void run.then(forget, forget)
}

export function markPendingSetup(connectionId: string, commit: string): void {
  useDeviceStore.getState().updateConnection(connectionId, { pendingPluginSetup: commit })
}

export function clearPendingSetup(connectionId: string): void {
  useDeviceStore.getState().updateConnection(connectionId, { pendingPluginSetup: undefined })
}

/** The pending setup and the update behind it, as a caller saw them. */
export interface PendingSnapshot {
  pending: string | undefined
  update: Connection['pluginUpdate']
}

/** What the device store holds now for the connection (nothing for a connection that is gone). */
export function pendingSnapshot(connectionId: string): PendingSnapshot {
  const found = useDeviceStore.getState().connections.find(connection => connection.id === connectionId)
  return { pending: found?.pendingPluginSetup, update: found?.pluginUpdate }
}

function sameUpdate(a: Connection['pluginUpdate'], b: Connection['pluginUpdate']): boolean {
  return a !== undefined && b !== undefined && a.target === b.target && a.previous === b.previous && a.previousSchema === b.previousSchema
}

/**
 * Clears the pending setup and the update behind it once the plugin's setup
 * ran, each only if the store still holds what the caller saw before the
 * setup began. A setup takes a while, and an update started meanwhile has set
 * both again for code that has not had its setup yet.
 */
export function clearPendingSetupIfUnchanged(connectionId: string, seen: PendingSnapshot): void {
  const now = pendingSnapshot(connectionId)
  const patch: Partial<Pick<Connection, 'pendingPluginSetup' | 'pluginUpdate'>> = {}
  if (seen.pending !== undefined && now.pending === seen.pending) {
    patch.pendingPluginSetup = undefined
  }
  if (sameUpdate(now.update, seen.update)) {
    patch.pluginUpdate = undefined
  }
  if (Object.keys(patch).length > 0) {
    useDeviceStore.getState().updateConnection(connectionId, patch)
  }
}

/**
 * How asking to finish the pending setup ended: `none`, there is no pending
 * setup; `waiting`, there is one, but not for the code that answers now (or
 * the plugin is not ready, or a run that does the setup itself is going);
 * `done`, the plugin's setup ran and `report` is what it did.
 */
export type PendingSetupResult = { kind: 'none' } | { kind: 'waiting' } | { kind: 'done'; report: SetupState }

const NONE: PendingSetupResult = { kind: 'none' }
const WAITING: PendingSetupResult = { kind: 'waiting' }

/**
 * Forgets that the app put the previous version back (`Connection.pluginWentBack`)
 * once a check shows another install than the commit it put back: what the
 * Finish screen says about going back holds for that commit only. A check
 * without a health read shows no install and changes nothing. Writes nothing
 * when there is nothing to forget, since every screen that reads the store
 * would redraw.
 */
export function forgetWentBackIfMoved(connectionId: string, check: ServerCheck): void {
  const back = useDeviceStore.getState().connections.find(connection => connection.id === connectionId)?.pluginWentBack
  if (back !== undefined && 'health' in check && check.health.install?.commit !== back.to) {
    useDeviceStore.getState().updateConnection(connectionId, { pluginWentBack: undefined })
  }
}

async function runPendingSetup(port: GatewayPort, connectionId: string, seen: PendingSnapshot): Promise<PendingSetupResult> {
  const report = await port.ergates.setup()
  clearPendingSetupIfUnchanged(connectionId, seen)
  return { kind: 'done', report }
}

/**
 * Runs the plugin's setup when the check finds the plugin ready and the
 * connection has a pending setup, then clears the flag (and the update it
 * belonged to) and answers `done` with the report. A flag or update that
 * changed while the setup ran, because an update started meanwhile, stays.
 *
 * It calls nothing otherwise. A connection without the flag answers `none`.
 * While a run is going for the connection it answers `waiting`: the run runs
 * the setup itself, and a second one would enable the plugin in every profile
 * again. It also answers `waiting` for a check that is not ready, and while a
 * git install answers with other code than the pending commit: after an
 * update the old code keeps answering until Hermes restarts, and the setup
 * belongs to the new code. A manual copy and a plugin that says nothing about
 * its install name no commit, so they run.
 *
 * The flag is read from the device store by `connection.id`, so a connection
 * object that is out of date cannot start a second setup. Callers at the same
 * time share one setup and its result. A setup that fails keeps the flag and
 * rejects (a 401 too), so the caller can show the error and try again with
 * the next check.
 */
export async function finishPendingSetup(port: GatewayPort, connection: Connection, check: ServerCheck): Promise<PendingSetupResult> {
  if (isSetupRunning(connection.id)) {
    return WAITING
  }
  const seen = pendingSnapshot(connection.id)
  const { pending } = seen
  if (pending === undefined) {
    return NONE
  }
  if (check.kind !== 'ready') {
    return WAITING
  }
  const { install } = check.health
  if (install?.kind === 'git install' && install.loaded_commit !== pending) {
    return WAITING
  }
  const going = finishing.get(connection.id)
  if (going) {
    return going
  }
  const attempt = runPendingSetup(port, connection.id, seen)
  finishing.set(connection.id, attempt)
  const forget = () => {
    finishing.delete(connection.id)
  }
  void attempt.then(forget, forget)
  return attempt
}
