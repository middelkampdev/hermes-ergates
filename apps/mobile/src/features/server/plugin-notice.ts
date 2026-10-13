/**
 * What a screen says in place when the server's plugin cannot do its job: one
 * short sentence and, when the user can fix it, the screen that does. Home,
 * Settings and every feature that calls the plugin read the same value, so a
 * missing, turned off, unloaded or outdated plugin is never shown as a raw
 * "Not found". Pure: the screens render this.
 */

import { isGatewayError } from '@/gateway/errors'

import type { ServerCheck } from './server-check'

/** The screens a notice can lead to: the setup screen and the Finish screen. */
export type NoticeRoute = '/server' | '/server/finish'

export interface PluginNotice {
  text: string
  /** What the user can tap to fix it; null when only an update of the app or the server's own repair helps. */
  action: { label: string; route: NoticeRoute } | null
}

/**
 * The notice of a server that has no Ergates plugin. Also the words for a
 * screen that only knows its route answered "not found" while no check
 * says why.
 */
export const MISSING_NOTICE: PluginNotice = { text: 'Ergates is not set up on this server.', action: { label: 'Set up', route: '/server' } }

/**
 * The notice for a check, or null when the plugin works or nothing is known
 * (a check that has not answered, or could not reach the server): the screen
 * then behaves as it did before there was a check.
 */
export function pluginNotice(check: ServerCheck | undefined): PluginNotice | null {
  switch (check?.kind) {
    case undefined:
    case 'ready':
    case 'unknown':
      return null
    case 'missing':
      return MISSING_NOTICE
    case 'disabled':
      return { text: 'The Ergates plugin is turned off on this server.', action: { label: 'Turn on', route: '/server' } }
    case 'not_loaded':
      return { text: 'Hermes has not loaded the Ergates plugin yet.', action: { label: 'Show me how', route: '/server/finish' } }
    case 'outdated':
      return { text: 'The Ergates plugin on this server needs an update.', action: { label: 'Update', route: '/server/finish' } }
    case 'app_outdated':
      return { text: "This server's Ergates plugin needs a newer version of this app. Update Ergates.", action: null }
    case 'unavailable':
      return { text: `The Ergates plugin cannot open its data on this server: ${check.message}`, action: null }
  }
}

/**
 * The value line of the plugin row in Settings: the plugin's version when it
 * works, else the notice. `failed` is true when the check itself failed; an
 * earlier answer still wins over it.
 */
export function pluginRowSubtitle(check: ServerCheck | undefined, failed: boolean): string {
  if (check?.kind === 'ready') {
    return check.health.plugin_version
  }
  const notice = pluginNotice(check)
  if (notice !== null) {
    return notice.text
  }
  return check === undefined && !failed ? 'Checking…' : 'Could not check'
}

/**
 * The notice to show in place of a failed read's own message, or null to keep
 * that message. A lost connection, a timeout and a refused session say
 * something the notice does not (it may be out of date), so they keep theirs.
 */
export function noticeForError(notice: PluginNotice | null, error: unknown): PluginNotice | null {
  const keepsOwnMessage = isGatewayError(error) && (error.kind === 'network' || error.kind === 'timeout' || error.kind === 'unauthorized')
  return keepsOwnMessage ? null : notice
}

/** The neutral line a feature shows while the server check is asked again (`featureNotice`). */
export const CHECKING_NOTICE: PluginNotice = { text: 'Checking your server…', action: null }

/**
 * Whether a failed call answered 404 without an Ergates error code: the route
 * itself is missing (the plugin is off, gone or not loaded), not a record the
 * plugin could not find.
 */
export function isBareNotFound(error: unknown): boolean {
  return isGatewayError(error) && error.kind === 'not_found' && error.code === undefined
}

/** How far asking the check again for one error has got: not asked yet, asked and not answered, or answered. */
export type Recheck = 'not_asked' | 'asking' | 'answered'

export interface FeatureNotice {
  /** What the feature shows in place of its own error; null to show that error (or nothing). */
  notice: PluginNotice | null
  /** True while the check is asked again: `notice` is the neutral `CHECKING_NOTICE`. */
  checking: boolean
  /** Ask the check again now. */
  recheck: boolean
}

/**
 * The notice for a feature that calls the plugin, given its last error. A
 * cached check can say `ready` for up to a minute after the plugin was turned
 * off, so a missing route under a ready check asks the check again, once for
 * that error, and shows `CHECKING_NOTICE` until the fresh check answers. Then
 * the fresh check's notice shows, or, when it still says ready, the feature's
 * own error.
 */
export function featureNotice(check: ServerCheck | undefined, error: unknown, recheck: Recheck): FeatureNotice {
  const routeMissingUnderReady = check?.kind === 'ready' && isBareNotFound(error)
  if (!routeMissingUnderReady || recheck === 'answered') {
    return { notice: pluginNotice(check), checking: false, recheck: false }
  }
  return { notice: CHECKING_NOTICE, checking: true, recheck: recheck === 'not_asked' }
}

/** The error the check was asked again for, and the moment of the check's last answer or failure at that time (epoch ms). */
export interface AskedRecheck {
  error: unknown
  after: number
}

/**
 * Where asking again stands for `error`. `answeredAt` is the moment of the
 * check's last answer or failure (epoch ms): a later one than when it was
 * asked is the fresh answer.
 */
export function recheckState(asked: AskedRecheck | null, error: unknown, answeredAt: number): Recheck {
  if (asked === null || asked.error !== error) {
    return 'not_asked'
  }
  return answeredAt > asked.after ? 'answered' : 'asking'
}
