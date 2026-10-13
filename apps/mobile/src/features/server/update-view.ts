/**
 * What the "Update ready" screen shows, as one value: the text, the source
 * line, the steps and the buttons for the update this build offers and the
 * state of the update run. Every rule and every string of that screen lives
 * here, so the screen only draws an `UpdateView` and does what a tapped
 * `action` names. Pure: no React, no gateway.
 */

import type { Connection } from '@/state/device-store'

import { pluginNotice } from './plugin-notice'
import { compareVersions, type UpdateOffer } from './plugin-version'
import { isSignedOut, type ServerCheck } from './server-check'
import type { StepStatus } from './setup-run'
import { failedProfiles, SIGN_IN, UNREACHABLE, type HeldCheck } from './setup-view'
import type { UpdateDeps, UpdateOutcome, UpdateStep } from './update-run'

/** `retry` runs the update again after a failed run; `check_again` asks the server again after a check that could not tell. */
export type UpdateAction = 'update' | 'retry' | 'finish' | 'done' | 'check_again' | 'sign_in'

export interface UpdateView {
  title: string
  /** Paragraphs above the source line. */
  body: string[]
  /** What gets installed and from where; null when there is no update to name. */
  source: string | null
  /** The paragraph below the source line: that Hermes has to restart, or nothing when the connection learned it need not. */
  note: string | null
  /** True when the screen draws the switch for keeping the plugin up to date under the source line. */
  autoUpdateSwitch: boolean
  primary: { label: string; action: UpdateAction } | null
  /** `later` records that the user was asked about this update and goes Home; `not_now` only goes Home. */
  secondary: { label: string; action: 'later' | 'not_now' } | null
  /** The four steps of a run, in order; null before a run starts. */
  steps: { label: string; status: StepStatus }[] | null
}

/** What the screen knows about the run it started or rejoined. `outcome` is null while the run is going. */
export interface UpdateRunState {
  steps: Record<UpdateStep, StepStatus>
  outcome: UpdateOutcome | null
}

/** The state of a screen that just started a run, or rejoined one that is going: no step has reported yet. */
export const PENDING_UPDATE_RUN: UpdateRunState = { steps: { pause: 'pending', install: 'pending', start: 'pending', setup: 'pending' }, outcome: null }

/** The commits `runUpdate` takes besides the port, the build and the connection. */
export type UpdateTarget = Pick<UpdateDeps, 'target' | 'previous' | 'previousSchema' | 'goingBack'>

const TITLE = 'Update ready'
const UP_TO_DATE = 'The plugin on your server is up to date.'
const RESTART_NOTE = 'Hermes has to restart to finish the update. Ergates shows you how.'

const NOT_NOW = { label: 'Not now', action: 'not_now' } as const
const LATER = { label: 'Later', action: 'later' } as const
const DONE = { label: 'Done', action: 'done' } as const
const SHOW_ME_HOW = { label: 'Show me how', action: 'finish' } as const
const TRY_AGAIN = { label: 'Try again', action: 'retry' } as const

const UPDATE_STEPS: readonly { step: UpdateStep; label: string }[] = [
  { step: 'pause', label: 'Turning the old version off' },
  { step: 'install', label: 'Installing the update' },
  { step: 'start', label: 'Starting it' },
  { step: 'setup', label: 'Setting up your agents' }
]

const GOING_BACK_STEPS: readonly { step: UpdateStep; label: string }[] = [
  { step: 'pause', label: 'Turning the new version off' },
  { step: 'install', label: 'Installing the previous version' },
  { step: 'start', label: 'Starting it' },
  { step: 'setup', label: 'Setting up your agents' }
]

/** The four steps of a run in order, each with its status; a going back names them for what they do. */
export function updateSteps(run: UpdateRunState, goingBack = false): { label: string; status: StepStatus }[] {
  return (goingBack ? GOING_BACK_STEPS : UPDATE_STEPS).map(({ step, label }) => ({ label, status: run.steps[step] }))
}

/** The switch sits under the source line, so a view has it exactly when it names a source. */
function view(parts: Partial<Omit<UpdateView, 'autoUpdateSwitch'>> = {}): UpdateView {
  return { title: TITLE, body: [], source: null, note: null, autoUpdateSwitch: Boolean(parts.source), primary: null, secondary: null, steps: null, ...parts }
}

function signInView(steps: UpdateView['steps']): UpdateView {
  return view({ body: [SIGN_IN], primary: { label: 'Sign in again', action: 'sign_in' }, secondary: NOT_NOW, steps })
}

/** The update this check offers, from a plugin that works (`ready`) or one that needs it (`outdated`); null for any other check. */
export function offerOf(check: ServerCheck | undefined): UpdateOffer | null {
  return check?.kind === 'ready' || check?.kind === 'outdated' ? check.update : null
}

/** The commits of the update an offer describes. */
export function targetOf(offer: UpdateOffer): UpdateTarget {
  return { target: offer.commit, previous: offer.previous, previousSchema: offer.previousSchema, goingBack: false }
}

/**
 * The commits for Try again: those of the update the server needs now, from
 * the check that was just asked again. It is null, and nothing may be
 * installed, when asking failed (the check would be an old one), when the
 * offer is gone (the server already has the update, or a newer plugin), or
 * when the check offers none. The offer is the only guard against installing
 * over a newer plugin, so a failed run's own commits are never reused.
 */
export function retryTarget(check: HeldCheck): UpdateTarget | null {
  if (check.error) {
    return null
  }
  const offer = offerOf(check.data)
  return offer === null ? null : targetOf(offer)
}

/**
 * The commit a tap records as asked about, or null. Both answers to the
 * question (`Update now` and `Later`) count, so the screen opens by itself
 * once per update whatever the ending.
 */
export function askedUpdateFor(action: UpdateAction | 'later' | 'not_now', offer: UpdateOffer | null): string | null {
  return offer !== null && (action === 'update' || action === 'later') ? offer.commit : null
}

/** Whether this connection has learned that the server's Hermes starts a new plugin without a restart: its version is known and is the one seen to do so, or newer. */
function needsNoRestart(check: ServerCheck, connection: Connection): boolean {
  const learned = connection.pluginRemountsFrom
  const version = 'hermesVersion' in check ? check.hermesVersion : null
  if (learned === undefined || version === null) {
    return false
  }
  const order = compareVersions(version, learned)
  return order === 0 || order === 1
}

function readyView(offer: UpdateOffer, check: ServerCheck, connection: Connection): UpdateView {
  return view({
    body: [`Ergates server plugin ${offer.to} is ready for your server. You have ${offer.from}.`],
    source: `From github.com/middelkampdev/hermes-ergates, commit ${offer.commit.slice(0, 7)}.`,
    note: needsNoRestart(check, connection) ? null : RESTART_NOTE,
    primary: { label: 'Update now', action: 'update' },
    secondary: LATER
  })
}

/** The screen has no update to start, whatever opened it: it says what the server says and leaves. */
function noOfferView(check: ServerCheck): UpdateView {
  if (check.kind === 'ready') {
    return view({ body: [UP_TO_DATE], primary: DONE })
  }
  if (check.kind === 'unknown') {
    return view({ body: [UNREACHABLE], primary: { label: 'Try again', action: 'check_again' }, secondary: NOT_NOW })
  }
  const notice = pluginNotice(check)
  return view({ body: notice === null ? [] : [notice.text], primary: DONE })
}

function runView(run: UpdateRunState): UpdateView {
  const steps = updateSteps(run)
  const { outcome } = run
  if (outcome === null) {
    return view({ steps })
  }
  switch (outcome.kind) {
    case 'done':
      return view({ body: [UP_TO_DATE, ...failedProfiles(outcome.setup)], primary: DONE, steps })
    case 'manual':
    case 'restart':
      return view({ primary: SHOW_ME_HOW, secondary: NOT_NOW, steps })
    case 'sign_in':
      return signInView(steps)
    case 'failed':
      return view({ body: [outcome.message], primary: TRY_AGAIN, secondary: LATER, steps })
  }
}

/**
 * The view for the update the check offers (`offer`, from `offerOf`) and,
 * once the user started it, the run: a run decides everything and the check
 * is ignored, because the check changes under a run (the plugin goes off,
 * then answers with the new code) while the screen keeps showing the run.
 * Without an offer there is nothing to start.
 */
export function updateView(offer: UpdateOffer | null, check: ServerCheck, connection: Connection, run: UpdateRunState | null): UpdateView {
  if (run !== null) {
    return runView(run)
  }
  return offer === null ? noOfferView(check) : readyView(offer, check, connection)
}

/**
 * The view for the screen, or null while the first check is still on its way.
 * A run decides everything. Without one, a refused session wins over the older
 * answer the check still holds, and any other failed read is a server the
 * check could not reach.
 */
export function updateScreenView(check: HeldCheck, connection: Connection, run: UpdateRunState | null): UpdateView | null {
  if (run !== null) {
    return updateView(null, check.data ?? { kind: 'unknown' }, connection, run)
  }
  if (isSignedOut(check.error)) {
    return signInView(null)
  }
  if (check.data) {
    return updateView(offerOf(check.data), check.data, connection, null)
  }
  return check.error ? updateView(null, { kind: 'unknown' }, connection, null) : null
}
