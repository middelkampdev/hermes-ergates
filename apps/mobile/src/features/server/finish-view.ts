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

import { PLUGIN_IDENTIFIER, PLUGIN_NAME, type BuildRecord } from './build-record'
import manualCommands from './manual-commands.json'
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
 * plugin by itself. `enable`: the plugin is installed but turned off, so
 * only the enable is left; `refused` when Hermes refused to turn it on
 * during the last run (`detail` is its text). `update`: move a git install to
 * this build's commit. `update_copy`: update the folder a manual copy comes
 * from. `restart`: the plugin is enabled but Hermes has not loaded it.
 * `deployment`: the Ergates deployment brings its own plugin.
 */
export type FinishVariant =
  | { kind: 'install'; restart: boolean; failure: ManualFailure | null; detail: string | null }
  | { kind: 'enable'; refused: boolean; detail: string | null }
  | { kind: 'update' }
  | { kind: 'update_copy' }
  | { kind: 'restart' }
  | { kind: 'deployment' }

/** Why the install is by hand: how the last setup run ended (`lastManualOutcome`). */
export interface FinishManual {
  failure: ManualFailure
  detail: string | null
}

export type FinishAction = 'check' | 'done' | 'sign_in'

/** How the plugin's setup stands once the server answers: not run yet, done, or failed with the message to show. */
export type SetupProgress = { state: 'pending' } | { state: 'done' } | { state: 'failed'; message: string }

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
  /** True when the plugin's setup went through. */
  done: boolean
  primary: { label: string; action: FinishAction }
}

const TITLE = 'Finish on your server'
const DEPLOYMENT_TITLE = 'Update your Ergates deployment'
const RUN_INTRO = 'On your server, as the user that runs Hermes, run:'
const TURNED_OFF_INTRO = `The plugin is on your server but turned off. ${RUN_INTRO}`
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

/** Hermes's own text is cut here, as the gateway cuts it, so it cannot fill the screen. */
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
 * `manual` is how the last setup run ended by hand, if it did. A server that
 * has moved on wins over it: once the plugin is installed, a stale "the
 * install failed" is not shown. Before the first check (`null`) it is all
 * there is to go on.
 */
export function finishVariant(check: ServerCheck | null, manual: FinishManual | null): FinishVariant | null {
  if (check === null) {
    return manual === null ? null : manualVariant(manual)
  }
  switch (check.kind) {
    case 'missing':
      // An old Hermes, or one the app cannot read, does not load a plugin installed behind its back.
      return installVariant(manual, check.reason === 'too_old' || check.reason === 'unknown')
    case 'disabled':
      // The plugin is there, so installing over it would be refused: whatever went wrong before, turning it on is what is left.
      return manual?.failure === 'enable_refused' ? manualVariant(manual) : { kind: 'enable', refused: false, detail: null }
    case 'not_loaded':
    case 'restart_needed':
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

/** The variant for how a run ended by hand, when the server has not said yet what it has. A refused enable means the plugin is on the server. */
function manualVariant(manual: FinishManual): FinishVariant {
  return manual.failure === 'enable_refused' ? { kind: 'enable', refused: true, detail: manual.detail } : installVariant(manual, false)
}

/** The commit this build installs, or null: the command needs it. */
function commitOf(build: BuildRecord | null): string | null {
  return build?.requiredPlugin.commit ?? null
}

/**
 * The commit to record as the pending setup, or null. Only a server that has
 * answered says the plugin is to be put on it, turned on or updated by hand:
 * a missing plugin, one that is turned off, or an outdated git install or
 * manual copy. The setup then runs once the plugin answers. Nothing else
 * records it: not a link, not the failure of an earlier run, not a page that
 * has no answer yet. A restart or a deployment installs nothing.
 */
export function pendingCommit(check: ServerCheck | null, build: BuildRecord | null): string | null {
  const needsSetup = check?.kind === 'missing' || check?.kind === 'disabled' || (check?.kind === 'outdated' && check.installKind !== 'deployment')
  return needsSetup ? commitOf(build) : null
}

/**
 * The install command, or with `force` the update, for this build's commit.
 * The templates live in `manual-commands.json`, which the live contract suite
 * runs against a running Hermes without a terminal. `--yes-deps` answers the
 * dependency question Hermes asks for any plugin with a pyproject: without a
 * terminal, Hermes takes the missing answer as a no and leaves the plugin off.
 */
function installCommand(commit: string, force: boolean): string {
  const template = force ? manualCommands.update : manualCommands.install
  return template.replace('{identifier}', PLUGIN_IDENTIFIER).replace('{commit}', commit)
}

const ENABLE_COMMAND = manualCommands.enable.replace('{name}', PLUGIN_NAME)

/**
 * White space and the characters that end a line or do not show: the control characters (U+0000 to U+001F and U+007F to U+009F, U+0085 among them) and the
 * line and paragraph separators. Written out, because the app's JavaScript engine may lack Unicode property escapes.
 */
const LINE_BREAKING = /[\s\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g
/** The characters that hide or reorder text: zero-width marks, the direction marks, and the bidirectional embeddings, overrides and isolates. */
const HIDING = /[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g

/** Hermes's text on one line and in the order it is written: a line break would let it put a line of its own beside the command, and a hidden or reordering character would let it show something else. */
function oneLine(text: string | null): string | null {
  const line = text?.replace(HIDING, '').replace(LINE_BREAKING, ' ').trim().slice(0, MAX_DETAIL).trim()
  return line ? line : null
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
      return refusalLine('Hermes refused to turn it on', detail)
    case 'refused':
      return refusalLine('Hermes refused the install', detail)
  }
}

function refusalLine(refusal: string, detail: string | null): string {
  const text = oneLine(detail)
  return text === null ? `${refusal}.` : `${refusal}: ${text}`
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
      // Without a command there is nothing to restart after.
      return { intro: [...reason, RUN_INTRO], command: commit === null ? null : installCommand(commit, false), restart: commit !== null && variant.restart }
    }
    case 'enable': {
      const intro = variant.refused ? [failureLine('enable_refused', variant.detail), RUN_INTRO] : [TURNED_OFF_INTRO]
      return { intro, command: ENABLE_COMMAND, restart: false }
    }
    case 'update':
      return { intro: [RUN_INTRO], command: commit === null ? null : installCommand(commit, true), restart: commit !== null }
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

function statusOf(check: ServerCheck | null, setup: SetupProgress): string {
  if (check === null) {
    return CHECKING
  }
  if (check.kind !== 'ready') {
    return WAITING
  }
  // A ready server is not done until the plugin's setup went through: it is still being asked, or it said no.
  return setup.state === 'failed' ? setup.message : CHECKING
}

/**
 * The page for a variant and the latest check. `variant` is null until the
 * screen knows one. `check` is `'sign_in'` when the server refused the
 * session, which shows only that and the way to stay signed in. `setup` says
 * how the plugin's setup went after the server answered: the page is done
 * only when it went through, and stays done whatever a later check says; a
 * failure shows its message while the server is ready, and the next ready
 * check tries again.
 *
 * Once the server answers (ready), asks for a new sign-in, or the setup is
 * done, the intro, the command and the restart lines are gone: the user did
 * what they were asked.
 */
export function finishView(
  variant: FinishVariant | null,
  build: BuildRecord | null,
  check: ServerCheck | 'sign_in' | null,
  setup: SetupProgress = { state: 'pending' }
): FinishView {
  const title = variant?.kind === 'deployment' ? DEPLOYMENT_TITLE : TITLE
  const guide = { label: GUIDE_LABEL, url: `${SERVER_GUIDE_URL}${anchorOf(variant)}` }
  if (setup.state === 'done') {
    return { title, intro: [], command: null, restartLines: null, guide, status: READY, done: true, primary: DONE }
  }
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
  const status = statusOf(check, setup)
  if (variant === null || check?.kind === 'ready') {
    return { title, intro: [], command: null, restartLines: null, guide, status, done: false, primary: CHECK }
  }
  const { intro, command, restart } = instructionsFor(variant, build)
  return { title, intro, command, restartLines: restart ? [...RESTART_LINES] : null, guide, status, done: false, primary: CHECK }
}

/** What a failed plugin setup shows in the status line: the gateway's own message, which carries no secrets. */
export function setupProblem(error: unknown): string {
  return isGatewayError(error) ? error.message : UNEXPECTED_PROBLEM
}
