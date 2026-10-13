/**
 * When the update shows up: for a check that offers one, whether the Update
 * ready screen opens by itself, the update runs without asking, or only a line
 * on Home offers it. With the switch off nothing opens and nothing runs by
 * itself, and a target runs without asking at most once, so a run that failed
 * falls back to the line instead of starting again at every check. Pure: Home
 * and the sign-in read these, the hook and `silent-update.ts` act on them.
 */

import type { Connection } from '@/state/device-store'

import type { RunKind } from './pending-setup'
import type { PluginNotice } from './plugin-notice'
import { autoUpdate, compareVersions, remountsWithoutRestart, type UpdateOffer } from './plugin-version'
import { hermesVersionIn, type ServerCheck } from './server-check'
import type { UpdateOutcome } from './update-run'
import { offerOf } from './update-view'

export type UpdateTrigger = 'open_screen' | 'run_silently' | 'show_line'

/**
 * What the update does for a check, or null when the check offers none.
 * `hermesVersion` is the version that check read from the server.
 */
export function updateAction(check: ServerCheck | undefined, connection: Connection, hermesVersion: string | null): UpdateTrigger | null {
  const offer = offerOf(check)
  if (offer === null) {
    return null
  }
  if (!autoUpdate(connection) || connection.askedUpdateFor === offer.commit) {
    return 'show_line'
  }
  return remountsWithoutRestart(connection, hermesVersion) ? 'run_silently' : 'open_screen'
}

const UPDATE_LINE: PluginNotice = { text: 'An update for the Ergates plugin is ready.', action: { label: 'Update', route: '/server/update' } }

/**
 * The line that offers the update of a plugin that works, or null: it shows
 * only where the update neither opens nor runs by itself. A plugin that cannot
 * serve this app has a notice of its own (`pluginNotice`) with the same button.
 */
export function updateLineFor(check: ServerCheck | undefined, connection: Connection): PluginNotice | null {
  if (check?.kind !== 'ready' || updateAction(check, connection, hermesVersionIn(check)) !== 'show_line') {
    return null
  }
  return UPDATE_LINE
}

/** The check answer a screen holds, and what it already did about the answers before. */
export interface AnswerOnScreen {
  check: ServerCheck | undefined
  connection: Connection
  /** `answerKey` of this answer, and of the last one the screen acted on. */
  key: string
  doneKey: string | null
  /** True while the answer is within the check's stale time: an update never starts from an old answer. */
  fresh: boolean
  /** The run going for the connection, if any. */
  running: RunKind | null
}

/** Names one answer of one connection's check. */
export function answerKey(connectionId: string, answeredAt: number): string {
  return `${connectionId}:${answeredAt}`
}

/**
 * What a screen does now about the answer it holds: open the update screen or
 * run the update, at most once for one answer, only from a fresh answer and
 * never while a run is going for the connection. The line (`show_line`) is not
 * an action, the screen just shows it.
 */
export function actionToTake({ check, connection, key, doneKey, fresh, running }: AnswerOnScreen): 'open_screen' | 'run_silently' | null {
  if (check === undefined || !fresh || running !== null || key === doneKey) {
    return null
  }
  const action = updateAction(check, connection, hermesVersionIn(check))
  return action === 'open_screen' || action === 'run_silently' ? action : null
}

/**
 * What a run without asking leaves on the connection. A finished update is
 * told to the user once. One that still needed a restart shows that what the
 * connection learned about this Hermes does not hold, so the next update asks
 * again. Any other end records nothing: the line offers the update while the
 * server still has one, a run that ended `stale` too.
 */
export function silentRunPatch(outcome: UpdateOutcome, offer: UpdateOffer): Partial<Pick<Connection, 'pluginUpdatedNotice' | 'pluginRemountsFrom'>> {
  switch (outcome.kind) {
    case 'done':
      return { pluginUpdatedNotice: { from: offer.from, to: offer.to } }
    case 'restart':
      return { pluginRemountsFrom: undefined }
    case 'manual':
    case 'stale':
    case 'failed':
    case 'sign_in':
      return {}
  }
}

/** The muted line on Home after the app updated the plugin without asking; an update within one version is a newer build of it. */
export function updatedNoticeLine({ from, to }: NonNullable<Connection['pluginUpdatedNotice']>): string {
  return compareVersions(from, to) === 0 ? `Ergates updated the plugin on your server to a newer build of ${to}.` : `Ergates updated the plugin on your server to ${to}.`
}
