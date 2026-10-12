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

export function markPendingSetup(connectionId: string, commit: string): void {
  useDeviceStore.getState().updateConnection(connectionId, { pendingPluginSetup: commit })
}

export function clearPendingSetup(connectionId: string): void {
  useDeviceStore.getState().updateConnection(connectionId, { pendingPluginSetup: undefined })
}

/**
 * Runs the plugin's setup when the check finds the plugin ready and the
 * connection has a pending setup, then clears the flag and returns the report.
 * Any other check, or a connection without the flag, answers null and calls
 * nothing. A setup that fails keeps the flag and rejects (a 401 too), so the
 * caller can show the error and try again with the next check.
 */
export async function finishPendingSetup(port: GatewayPort, connection: Connection, check: ServerCheck): Promise<SetupState | null> {
  if (check.kind !== 'ready' || connection.pendingPluginSetup === undefined) {
    return null
  }
  const report = await port.ergates.setup()
  clearPendingSetup(connection.id)
  return report
}
