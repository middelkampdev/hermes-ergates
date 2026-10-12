/**
 * What the "Finish on your server" screen shows, as one value: which of the
 * five cases the user is in, the text, the command and the button for it.
 * Every rule and every string of that screen lives here, so the screen only
 * draws a `FinishView` and does what the tapped action names. Pure: no React,
 * no gateway.
 *
 * The command is built from this build's record only. Nothing the server, an
 * agent, a message or a link says reaches it.
 */

import { isGatewayError } from '@/gateway/errors'

import { PLUGIN_IDENTIFIER, type BuildRecord } from './build-record'
import type { InstallKind, ServerCheck } from './server-check'
import type { ManualFailure } from './setup-run'

/** The page with the manual steps, the restart steps and the deployment steps; the anchors are `#manual`, `#restart`, `#deployment` and `#stay-signed-in`. */
export const SERVER_GUIDE_URL = 'https://middelkamp.dev/ergates/server/'

/**
 * Why a restart of Hermes signs the user out, and where to read how to stay
 * signed in. The app never creates, sends or reads the secret that does it:
 * Hermes signs every session with it, reports nowhere whether one is set, and
 * the user sets it on the server.
 */
export const SIGNED_OUT_HINT = {
  text: 'Hermes signs you out when it restarts, unless your server has a fixed sign-in secret.',
  label: 'How to stay signed in',
  url: `${SERVER_GUIDE_URL}#stay-signed-in`
} as const

/** The heading above the restart lines. */
export const RESTART_HEADING = 'Then restart Hermes:'

/**
 * What the user has to do on the server. `install`: put the plugin on it by
 * hand, because one tap was not possible or Hermes refused (`failure` and
 * Hermes's own `detail`), and restart Hermes when it is too old to load the
 * plugin by itself. `update`: move a git install to this build's commit.
 * `update_copy`: update the folder a manual copy comes from. `restart`: the
 * plugin is enabled but Hermes has not loaded it. `deployment`: the Ergates
 * deployment brings its own plugin.
 */
export type FinishVariant =
  | { kind: 'install'; restart: boolean; failure: ManualFailure | null; detail: string | null }
  | { kind: 'update' }
  | { kind: 'update_copy' }
  | { kind: 'restart' }
  | { kind: 'deployment' }

/** Why the install is by hand, as the setup screen passes it in the route. */
export interface FinishManual {
  failure: ManualFailure
  detail: string | null
}

export type FinishAction = 'check' | 'done' | 'sign_in'

export interface FinishView {
  title: string
  /** Paragraphs above the command. Empty once the page has nothing left to ask. */
  intro: string[]
  /** The command to run on the server; null when there is none, or when this build does not know the commit. */
  command: string | null
  /** The ways to restart Hermes, under `RESTART_HEADING`; null when no restart is needed. */
  restartLines: string[] | null
  guide: { label: string; url: string }
  status: string
  /** True when the server is ready and nothing went wrong afterwards. */
  done: boolean
  primary: { label: string; action: FinishAction }
}

const TITLE = 'Finish on your server'
const DEPLOYMENT_TITLE = 'Update your Ergates deployment'
const RUN_INTRO = 'On your server, as the user that runs Hermes, run:'
const NOT_LOADED = 'Hermes has not loaded the Ergates plugin yet.'
const GUIDE_LABEL = 'Open the guide'
const CHECKING = 'Checking…'
const WAITING = 'Waiting for your server…'
const READY = 'Your server is ready.'
const SIGNED_OUT = 'Your server restarted. Sign in again to continue.'
const UNEXPECTED_PROBLEM = 'Could not set up your agents.'

const RESTART_LINES: readonly string[] = [
  'Hermes service: systemctl --user restart hermes-dashboard',
  'Docker: docker restart <container name>',
  'Hermes Desktop: quit it and open it again',
  'Started by hand: stop hermes serve and start it again'
]

const CHECK = { label: 'Check now', action: 'check' } as const
const DONE = { label: 'Done', action: 'done' } as const
const SIGN_IN = { label: 'Sign in again', action: 'sign_in' } as const

const MANUAL_FAILURES: readonly ManualFailure[] = ['scan_blocked', 'no_git', 'download_failed', 'enable_refused', 'refused']

/** Hermes's own text is cut here, as the gateway cuts it, so a link cannot fill the screen. */
const MAX_DETAIL = 200

function installVariant(manual: FinishManual | null, restart: boolean): FinishVariant {
  return { kind: 'install', restart, failure: manual?.failure ?? null, detail: manual?.detail ?? null }
}

function updateVariant(installKind: InstallKind): FinishVariant {
  switch (installKind) {
    case 'git install':
      return { kind: 'update' }
    case 'manual copy':
      return { kind: 'update_copy' }
    case 'deployment':
      return { kind: 'deployment' }
  }
}

/**
 * The variant a check leads to, or null when the check names none: the screen
 * then keeps the variant it had, so a server that answers `ready` (or that
 * could not be reached for one poll) does not change the page under the user.
 * A server that has moved on wins over the failure in the route: once the
 * plugin is installed, a stale "the install failed" is not shown. Before the
 * first check (`null`) the failure in the route is all there is to go on.
 */
export function finishVariant(check: ServerCheck | null, manual: FinishManual | null): FinishVariant | null {
  if (check === null) {
    return manual === null ? null : installVariant(manual, false)
  }
  switch (check.kind) {
    case 'missing':
      // An old Hermes, or one the app cannot read, does not load a plugin installed behind its back.
      return installVariant(manual, check.reason === 'too_old' || check.reason === 'unknown')
    case 'disabled':
      // A refused enable leaves the plugin installed but off.
      return manual === null ? null : installVariant(manual, false)
    case 'not_loaded':
      return { kind: 'restart' }
    case 'outdated':
      return updateVariant(check.installKind)
    case 'ready':
    case 'app_outdated':
    case 'unavailable':
    case 'unknown':
      return null
  }
}

function firstText(value: unknown): string | null {
  const first: unknown = Array.isArray(value) ? value[0] : value
  return typeof first === 'string' ? first : null
}

/** The failure in the Finish route's params, or null when there is none the app knows. Route params are text from outside, so nothing else is trusted. */
export function manualFromParams(params: Record<string, unknown>): FinishManual | null {
  const given = firstText(params.failure)
  const failure = MANUAL_FAILURES.find(code => code === given)
  if (failure === undefined) {
    return null
  }
  const detail = firstText(params.detail)
  return { failure, detail: detail ? detail.slice(0, MAX_DETAIL) : null }
}

/** The commit this build installs, or null: the command needs it. */
function commitOf(build: BuildRecord | null): string | null {
  return build?.requiredPlugin.commit ?? null
}

/**
 * The commit to record as the pending setup while the variant is on screen,
 * or null: the variants that end with the user installing or updating the
 * plugin by hand record it, so the setup runs once the plugin answers. A
 * restart or a deployment installs nothing.
 */
export function pendingCommit(variant: FinishVariant | null, build: BuildRecord | null): string | null {
  if (variant === null || variant.kind === 'restart' || variant.kind === 'deployment') {
    return null
  }
  return commitOf(build)
}

function installCommand(commit: string, force: boolean): string {
  return ['hermes plugins install', PLUGIN_IDENTIFIER, ...(force ? ['--force'] : []), `--ref ${commit}`, '--enable'].join(' ')
}

function failureLine(failure: ManualFailure, detail: string | null): string {
  switch (failure) {
    case 'scan_blocked':
      return "Hermes's security check stopped the install. Run the command to see the findings."
    case 'no_git':
      return 'Your server has no Git, which Hermes needs to install plugins. Install Git first.'
    case 'download_failed':
      return 'Your server could not download the plugin from GitHub.'
    case 'enable_refused':
    case 'refused':
      return detail === null ? 'Hermes refused the install.' : `Hermes refused the install: ${detail}`
  }
}

function anchorOf(variant: FinishVariant | null): string {
  switch (variant?.kind) {
    case undefined:
      return ''
    case 'restart':
      return '#restart'
    case 'deployment':
      return '#deployment'
    default:
      return '#manual'
  }
}

interface Instructions {
  intro: string[]
  command: string | null
  restart: boolean
}

function instructionsFor(variant: FinishVariant, build: BuildRecord | null): Instructions {
  const commit = commitOf(build)
  const version = build?.requiredPlugin.version
  switch (variant.kind) {
    case 'install': {
      const reason = variant.failure === null ? [] : [failureLine(variant.failure, variant.detail)]
      return { intro: [...reason, RUN_INTRO], command: commit === null ? null : installCommand(commit, false), restart: variant.restart }
    }
    case 'update':
      return { intro: [RUN_INTRO], command: commit === null ? null : installCommand(commit, true), restart: true }
    case 'update_copy': {
      const target = version === undefined ? 'the newest version' : `version ${version}`
      return { intro: [`Update the folder you copied or linked the plugin from to ${target}, then restart Hermes.`], command: null, restart: true }
    }
    case 'restart':
      return { intro: [NOT_LOADED], command: null, restart: true }
    case 'deployment': {
      const target = version === undefined ? 'the newest plugin' : `plugin ${version}`
      return { intro: [`This server runs the Ergates deployment, which brings its own plugin. Update the deployment to get ${target}.`], command: null, restart: false }
    }
  }
}

function statusOf(check: ServerCheck | null, problem: string | null): { status: string; done: boolean } {
  if (check === null) {
    return { status: CHECKING, done: false }
  }
  if (check.kind !== 'ready') {
    return { status: WAITING, done: false }
  }
  return problem === null ? { status: READY, done: true } : { status: problem, done: false }
}

/**
 * The page for a variant and the latest check. `variant` is null until the
 * screen knows one. `check` is `'sign_in'` when the server refused the
 * session, which shows only that and the way to stay signed in. `problem` is
 * what went wrong when the plugin's setup ran after a ready check; it counts
 * only while the server is ready, and the next ready check tries again.
 *
 * Once the server answers (ready) or asks for a new sign-in, the intro, the
 * command and the restart lines are gone: the user did what they were asked.
 */
export function finishView(variant: FinishVariant | null, build: BuildRecord | null, check: ServerCheck | 'sign_in' | null, problem: string | null = null): FinishView {
  const title = variant?.kind === 'deployment' ? DEPLOYMENT_TITLE : TITLE
  if (check === 'sign_in') {
    return {
      title,
      intro: [],
      command: null,
      restartLines: null,
      guide: { label: SIGNED_OUT_HINT.label, url: SIGNED_OUT_HINT.url },
      status: `${SIGNED_OUT} ${SIGNED_OUT_HINT.text}`,
      done: false,
      primary: SIGN_IN
    }
  }
  const { status, done } = statusOf(check, problem)
  const guide = { label: GUIDE_LABEL, url: `${SERVER_GUIDE_URL}${anchorOf(variant)}` }
  const primary = done ? DONE : CHECK
  if (variant === null || check?.kind === 'ready') {
    return { title, intro: [], command: null, restartLines: null, guide, status, done, primary }
  }
  const { intro, command, restart } = instructionsFor(variant, build)
  return { title, intro, command, restartLines: restart ? [...RESTART_LINES] : null, guide, status, done, primary }
}

/** Whether a failed call was the server refusing the session: the user has to sign in again. */
export function isSignedOut(error: unknown): boolean {
  return isGatewayError(error) && error.kind === 'unauthorized'
}

/** What a failed plugin setup shows in the status line: the gateway's own message, which carries no secrets. */
export function setupProblem(error: unknown): string {
  return isGatewayError(error) ? error.message : UNEXPECTED_PROBLEM
}
