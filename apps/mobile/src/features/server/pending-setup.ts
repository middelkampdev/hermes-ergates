/**
 * The pending setup: a plugin the app put on a server before the plugin's
 * `POST /setup` ran. `Connection.pendingPluginSetup` holds the commit and
 * stays until the setup succeeded, so a closed app, a lost connection or a
 * server restart in between never skips it. Without the flag the app never
 * calls `/setup` on its own: each call enables the plugin in every profile
 * again, which undoes a profile the owner turned off (ADR-042).
 */

import type { GatewayPort } from '@/gateway/port'
import type { SetupState } from '@/gateway/types'
import { useDeviceStore, type Connection } from '@/state/device-store'

import type { ServerCheck } from './server-check'

/** The setup that is going for each connection. */
const finishing = new Map<string, Promise<SetupState>>()

/** The connections with a setup run going (`runSetup`), until the run ends. */
const runs = new Set<string>()

/** Whether a setup run is going for the connection. */
export function isSetupRunning(connectionId: string): boolean {
  return runs.has(connectionId)
}

/** Records that a setup run is going for the connection until `run` settles. Kept here, not in `setup-run.ts`, because that module imports this one. */
export function trackSetupRun(connectionId: string, run: Promise<unknown>): void {
  runs.add(connectionId)
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

function pendingCommitOf(connectionId: string): string | undefined {
  return useDeviceStore.getState().connections.find(connection => connection.id === connectionId)?.pendingPluginSetup
}

async function runPendingSetup(port: GatewayPort, connectionId: string): Promise<SetupState> {
  const report = await port.ergates.setup()
  clearPendingSetup(connectionId)
  return report
}

/**
 * Runs the plugin's setup when the check finds the plugin ready and the
 * connection has a pending setup, then clears the flag and returns the report.
 *
 * It answers null and calls nothing for any other check, for a connection
 * without the flag, and for a connection whose run is going: the run runs the
 * setup itself, and a second one would enable the plugin in every profile
 * again. It also waits while a git install answers with other code than the
 * pending commit: after an update the old code keeps answering until Hermes
 * restarts, and the setup belongs to the new code. A deployment, a manual
 * copy and a plugin that says nothing about its install name no commit, so
 * they run.
 *
 * The flag is read from the device store by `connection.id`, so a connection
 * object that is out of date cannot start a second setup. Callers at the same
 * time share one setup and its result. A setup that fails keeps the flag and
 * rejects (a 401 too), so the caller can show the error and try again with
 * the next check.
 */
export async function finishPendingSetup(port: GatewayPort, connection: Connection, check: ServerCheck): Promise<SetupState | null> {
  if (check.kind !== 'ready' || isSetupRunning(connection.id)) {
    return null
  }
  const pending = pendingCommitOf(connection.id)
  const { install } = check.health
  if (pending === undefined || (install?.kind === 'git install' && install.loaded_commit !== pending)) {
    return null
  }
  const going = finishing.get(connection.id)
  if (going) {
    return going
  }
  const attempt = runPendingSetup(port, connection.id)
  finishing.set(connection.id, attempt)
  const forget = () => {
    finishing.delete(connection.id)
  }
  void attempt.then(forget, forget)
  return attempt
}
