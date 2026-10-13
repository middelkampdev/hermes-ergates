/**
 * The update that runs without asking, for a connection that learned its
 * Hermes starts a new plugin without a restart. It is the ordinary update run
 * with the bookkeeping around it: the target is recorded as handled before
 * anything changes on the server, so a run that fails is offered as a line
 * and never started again by itself, and what the run learned is left on the
 * connection (`silentRunPatch`). Plain async code over the gateway port, so
 * Node tests drive it with FakeGateway; Home calls it.
 */

import type { GatewayPort } from '@/gateway/port'
import { useDeviceStore } from '@/state/device-store'

import type { BuildRecord } from './build-record'
import type { UpdateOffer } from './plugin-version'
import { runUpdate, type UpdateOutcome } from './update-run'
import { silentRunPatch } from './update-trigger'
import { targetOf } from './update-view'

/** Runs the update `offer` describes and answers how it ended. A step's progress is not shown: nobody is watching. */
export async function updateSilently(port: GatewayPort, build: BuildRecord, connectionId: string, offer: UpdateOffer): Promise<UpdateOutcome> {
  const { updateConnection } = useDeviceStore.getState()
  updateConnection(connectionId, { askedUpdateFor: offer.commit })
  const outcome = await runUpdate({ port, build, connectionId, ...targetOf(offer) }, () => undefined)
  const patch = silentRunPatch(outcome, offer)
  if (Object.keys(patch).length > 0) {
    updateConnection(connectionId, patch)
  }
  return outcome
}

/** Forgets the version Home told the user about. Writes nothing when there is none, since every screen that reads the store would redraw. */
export function clearUpdatedNotice(connectionId: string): void {
  const { connections, updateConnection } = useDeviceStore.getState()
  if (connections.find(connection => connection.id === connectionId)?.pluginUpdatedNotice !== undefined) {
    updateConnection(connectionId, { pluginUpdatedNotice: undefined })
  }
}
