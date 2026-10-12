/**
 * What the "Set up your server" screen shows, as one value: the text, the
 * source line, the steps and the buttons for a server check and the state of
 * the setup run. Every rule and every string of that screen lives here, so
 * the screen only draws a `SetupView` and does what a tapped `action` names.
 * Pure: no React, no gateway.
 */

import type { BuildRecord } from './build-record'
import { parseHermesVersion } from './hermes-version'
import { isSignedOut, type ServerCheck } from './server-check'
import type { SetupOutcome, SetupStep, StepStatus } from './setup-run'

/** `retry` runs the setup again after a failed run; `check_again` asks the server again after a check that could not tell. */
export type SetupAction = 'run' | 'turn_on' | 'finish' | 'done' | 'retry' | 'check_again' | 'sign_in'

export interface SetupView {
  title: string
  /** Paragraphs above the source line. */
  body: string[]
  /** What gets installed and from where; null when no plugin version is known. */
  source: string | null
  /** The paragraph below the source line: what Hermes says about the source, or why one tap is not offered. */
  note: string | null
  primary: { label: string; action: SetupAction } | null
  secondary: { label: string; action: 'not_now' } | null
  /** The four steps of a run, in order; null before a run starts. */
  steps: { label: string; status: StepStatus }[] | null
}

/** What the screen knows about the run it started or rejoined. `outcome` is null while the run is going. */
export interface SetupRunState {
  steps: Record<SetupStep, StepStatus>
  outcome: SetupOutcome | null
}

/** The page title, also shown before the first check has answered. */
export const SETUP_TITLE = 'Set up your server'

const INTRO = 'Ergates needs its plugin on your Hermes server for routines, new agents from chat and notification settings. Chat works without it.'
const UNREVIEWED =
  "Hermes calls this an unreviewed source, because the plugin is not in the Hermes plugin catalog yet. Your server downloads it from GitHub and runs Hermes's security check before it installs it."
const TURNED_OFF = 'The Ergates plugin is on your server but turned off.'
const READY = 'Your server is ready.'
const SIGN_IN = 'Your server asked you to sign in again.'
const UNREACHABLE = 'Could not reach your server.'
const NO_COMMIT = 'This build of Ergates does not know which plugin version to install.'
const UNKNOWN_VERSION = "Ergates could not read your server's Hermes version, so you finish setup on the server."

const NOT_NOW = { label: 'Not now', action: 'not_now' } as const
const DONE = { label: 'Done', action: 'done' } as const
const SHOW_ME_HOW = { label: 'Show me how', action: 'finish' } as const

const STEPS: readonly { step: SetupStep; label: string }[] = [
  { step: 'install', label: 'Installing the plugin' },
  { step: 'enable', label: 'Turning it on' },
  { step: 'start', label: 'Starting it' },
  { step: 'setup', label: 'Setting up your agents' }
]

const STEP_WORDS: Record<StepStatus, string> = {
  pending: 'waiting',
  active: 'in progress',
  done: 'done',
  skipped: 'not needed',
  failed: 'failed'
}

/** A step's status in words, for a screen reader: the row's icon says it to the eye only. */
export function stepStatusWord(status: StepStatus): string {
  return STEP_WORDS[status]
}

function view(parts: Partial<SetupView> = {}): SetupView {
  return { title: SETUP_TITLE, body: [], source: null, note: null, primary: null, secondary: null, steps: null, ...parts }
}

function signInView(steps: SetupView['steps']): SetupView {
  return view({ body: [SIGN_IN], primary: { label: 'Sign in again', action: 'sign_in' }, secondary: NOT_NOW, steps })
}

/** The view for a check the server refused with a 401, when there is no check to show. */
export function signedOutView(): SetupView {
  return signInView(null)
}

function sourceLine(build: BuildRecord, commit: string): string {
  return `Ergates server plugin ${build.requiredPlugin.version} from github.com/middelkampdev/hermes-ergates, commit ${commit.slice(0, 7)}.`
}

/** `X.Y` of a Hermes version, for "not tested with Hermes X.Y". */
function minorOf(version: string | null): string {
  const parsed = parseHermesVersion(version ?? undefined)
  return parsed ? `${parsed[0]}.${parsed[1]}` : (version ?? 'unknown')
}

/** Why a server that is missing the plugin gets the guide, not one tap. */
function manualNote(check: Extract<ServerCheck, { kind: 'missing' }>, build: BuildRecord): string {
  switch (check.reason) {
    case 'too_old':
      return `Your server runs Hermes ${check.hermesVersion ?? 'unknown'}. One-tap setup needs Hermes ${build.hermesRange.oldest} or newer, so you finish it on the server.`
    case 'untested':
      return `Ergates is not tested with Hermes ${minorOf(check.hermesVersion)} yet, so you finish setup on the server.`
    default:
      return UNKNOWN_VERSION
  }
}

/** The commit this build installs, or null: one tap, and the command in the guide, both need it. */
function commitOf(build: BuildRecord | null): string | null {
  return build?.requiredPlugin.commit ?? null
}

function missingView(check: Extract<ServerCheck, { kind: 'missing' }>, build: BuildRecord | null): SetupView {
  const commit = commitOf(build)
  if (build === null || commit === null) {
    return view({ body: [INTRO], note: NO_COMMIT, secondary: NOT_NOW })
  }
  const source = sourceLine(build, commit)
  if (check.oneTap) {
    return view({ body: [INTRO], source, note: UNREVIEWED, primary: { label: 'Set up this server', action: 'run' }, secondary: NOT_NOW })
  }
  return view({ body: [INTRO], source, note: manualNote(check, build), primary: SHOW_ME_HOW, secondary: NOT_NOW })
}

function disabledView(build: BuildRecord | null): SetupView {
  // Turning the plugin on runs the whole setup, which records the commit first.
  if (commitOf(build) === null) {
    return view({ body: [TURNED_OFF], note: NO_COMMIT, secondary: NOT_NOW })
  }
  return view({ body: [TURNED_OFF], primary: { label: 'Turn it on', action: 'turn_on' }, secondary: NOT_NOW })
}

function failedProfiles(outcome: Extract<SetupOutcome, { kind: 'done' }>): string[] {
  const names = outcome.setup.profiles.filter(profile => !profile.enabled).map(profile => profile.name)
  return names.length > 0 ? [`Ergates could not be turned on for: ${names.join(', ')}.`] : []
}

function runView(run: SetupRunState): SetupView {
  const steps = STEPS.map(({ step, label }) => ({ label, status: run.steps[step] }))
  const { outcome } = run
  if (outcome === null) {
    return view({ steps })
  }
  switch (outcome.kind) {
    case 'done':
      return view({ body: [READY, ...failedProfiles(outcome)], primary: DONE, steps })
    case 'manual':
    case 'restart':
      return view({ primary: SHOW_ME_HOW, secondary: NOT_NOW, steps })
    case 'sign_in':
      return signInView(steps)
    case 'failed':
      return view({ body: [outcome.message], primary: { label: 'Try again', action: 'retry' }, secondary: NOT_NOW, steps })
  }
}

/**
 * The view for a server check and, once the user started the setup, the run:
 * a run in `run` decides everything and the check is ignored, because the
 * check changes under a run (the plugin turns up, then loads) while the screen
 * keeps showing the run.
 */
export function setupView(check: ServerCheck, build: BuildRecord | null, run: SetupRunState | null): SetupView {
  if (run !== null) {
    return runView(run)
  }
  switch (check.kind) {
    case 'missing':
      return missingView(check, build)
    case 'disabled':
      return disabledView(build)
    case 'ready':
      return view({ body: [READY], primary: DONE })
    case 'not_loaded':
    case 'outdated':
      return view({ primary: SHOW_ME_HOW, secondary: NOT_NOW })
    case 'unavailable':
      return view({ body: [check.message], secondary: NOT_NOW })
    case 'app_outdated':
      return view({ secondary: NOT_NOW })
    case 'unknown':
      return view({ body: [UNREACHABLE], primary: { label: 'Try again', action: 'check_again' }, secondary: NOT_NOW })
  }
}

/** The server check as the screen holds it: the last answer, and the error of the last read (null when it went through). */
export interface HeldCheck {
  data: ServerCheck | undefined
  error: unknown
}

/**
 * The view for the screen, or null while the first check is still on its
 * way. A run decides everything. Without one, a refused session wins over
 * the older answer the check still holds: after Try again on a server that
 * could not be reached, a 401 asks for a new sign-in instead of keeping
 * "Could not reach your server." Any other failed read is a server the
 * check could not reach.
 */
export function setupScreenView(check: HeldCheck, build: BuildRecord | null, run: SetupRunState | null): SetupView | null {
  if (run !== null) {
    return setupView(check.data ?? { kind: 'unknown' }, build, run)
  }
  if (isSignedOut(check.error)) {
    return signedOutView()
  }
  if (check.data) {
    return setupView(check.data, build, null)
  }
  return check.error ? setupView({ kind: 'unknown' }, build, null) : null
}

/** Whether the end of a run sends the user to the Finish screen: an install by hand, or a restart of Hermes. The screen reads the rest from the server and from `lastManualOutcome`, not from the route. */
export function opensFinish(outcome: SetupOutcome | null): boolean {
  return outcome?.kind === 'manual' || outcome?.kind === 'restart'
}
