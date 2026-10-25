/**
 * What the "Finish on your server" screen shows, as one value: which of the
 * five cases the user is in, the text, the command and the button for it.
 * Every rule and every string of that screen lives here, so the screen only
 * draws a `FinishView` and does what the tapped action names. Pure: no React,
 * no gateway.
 *
 * The command is built from this build's record only, or, for going back by
 * hand, from the commit the app recorded before the update, which must be a
 * full hash. Nothing the server, an agent, a message or a link says reaches it.
 */

import { isGatewayError } from '@/gateway/errors'
import type { Connection } from '@/state/device-store'

import { COMMIT_PATTERN, PLUGIN_IDENTIFIER, PLUGIN_NAME, type BuildRecord } from './build-record'
import manualCommands from './manual-commands.json'
import type { PendingSetupResult } from './pending-setup'
import { pluginNotice } from './plugin-notice'
import type { InstallKind, ServerCheck } from './server-check'
import type { ManualFailure, StepStatus } from './setup-run'
import type { LastUpdateRun, UpdateOutcome } from './update-run'
import { updateSteps, type UpdateRunState, type UpdateTarget } from './update-view'

/** The page with the manual steps and the restart steps; the anchors are `#manual`, `#restart` and `#stay-signed-in`. */
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
 * from. `restart`: the plugin is enabled but Hermes has not loaded it
 * (`after` is null), or an update is installed (`'update'`) or the app put
 * the previous version back (`'go_back'`) and Hermes has to restart to start
 * it.
 * `not_started`: an update the app installed did not come up after the
 * restart; `previous` is the commit the server had before it, and `goBack`
 * whether that version can still use the store (the app then puts it back).
 * `went_back`: the app put the previous version back and it answers; when
 * this app needs a newer plugin, the update did not start, and the guide
 * says what to check before trying again.
 */
export type FinishVariant =
  | { kind: 'install'; restart: boolean; failure: ManualFailure | null; detail: string | null }
  | { kind: 'enable'; refused: boolean; detail: string | null }
  | { kind: 'update' }
  | { kind: 'update_copy' }
  | { kind: 'restart'; after: 'update' | 'go_back' | null }
  | { kind: 'not_started'; previous: string; goBack: boolean }
  | { kind: 'went_back' }

/** Why the install is by hand: how the last setup run ended (`lastManualOutcome`). */
export interface FinishManual {
  failure: ManualFailure
  detail: string | null
}

/** What the Finish screen knows about the update of its connection. */
export interface FinishUpdate {
  /** The update the app started and has not finished (`Connection.pluginUpdate`). */
  started: Connection['pluginUpdate']
  /** The highest `store.min_schema_version` a health read showed since the update started, or null before one did. */
  schemaSeen: number | null
  /** The previous version the app put back (`Connection.pluginWentBack`); it counts for a check whose install commit is `to`. */
  wentBack: Connection['pluginWentBack']
  /** True when the last update run ended with the user installing by hand. */
  byHand: boolean
  /** True while the update run's call for a restart of Hermes is open: it asked for one and no poll has shown the server going away since. */
  awaitingRestart: boolean
}

/** No update under way. */
export const NO_UPDATE: FinishUpdate = { started: undefined, schemaSeen: null, wentBack: undefined, byHand: false, awaitingRestart: false }

/** What the screen holds about the update. */
export interface FinishUpdateParts {
  /** `Connection.pluginUpdate`. */
  started: Connection['pluginUpdate']
  /** The highest `store.min_schema_version` the polls showed since the update run started (`schemaSeenOf`), or null. */
  schemaSeen: number | null
  /** The connection's last update run in this session (`lastUpdateRun`); null after a relaunch. */
  last: LastUpdateRun | null
  /** Whether the polls showed a sign of the restart the update run asked for (`RestartWatch.seen`). */
  restartSeen: boolean
  /** `Connection.pluginWentBack`. */
  wentBack: Connection['pluginWentBack']
}

/**
 * What the screen knows about the update. The update and the previous version
 * being back are on the connection, so they hold after a relaunch too. How
 * the last run ended and what the polls showed of its restart come from
 * memory the update run keeps, so a page that mounts again knows the same;
 * after a relaunch no run is in memory, so no restart is waited for.
 */
export function finishUpdateOf({ started, schemaSeen, last, restartSeen, wentBack }: FinishUpdateParts): FinishUpdate {
  const kind = last?.outcome.kind
  return {
    started,
    schemaSeen,
    wentBack,
    byHand: last?.goingBack === false && kind === 'manual',
    awaitingRestart: last?.goingBack === false && kind === 'restart' && !restartSeen
  }
}

/** Whether `check` shows the previous version the app put back: its install commit is the one it installed. */
function showsWentBack(check: ServerCheck, wentBack: Connection['pluginWentBack']): boolean {
  return wentBack !== undefined && 'health' in check && check.health.install?.commit === wentBack.to
}

/** Whether the go back is still going: the page offers nothing and does not set up the plugin meanwhile. */
export function runIsGoing(run: UpdateRunState | null): boolean {
  return run !== null && run.outcome === null
}

export type FinishAction = 'check' | 'done' | 'sign_in' | 'go_back'

/**
 * How the plugin's setup stands once the server answers: not run yet, done,
 * failed with the message to show, or waiting for the code it belongs to,
 * which starts when Hermes restarts.
 */
export type SetupProgress = { state: 'pending' } | { state: 'done' } | { state: 'failed'; message: string } | { state: 'waiting' }

/**
 * Whether the page is done once it asked to finish the pending setup
 * (`finishPendingSetup`) for `check`: the setup ran, or none was pending and
 * the server is ready. A setup that waits for the new code is not done,
 * although the old code answers ready meanwhile.
 */
export function finishDone(result: PendingSetupResult, check: ServerCheck): boolean {
  switch (result.kind) {
    case 'done':
      return true
    case 'none':
      return check.kind === 'ready'
    case 'waiting':
      return false
  }
}

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
  /** The steps of the run that puts the previous version back; null when none has started. */
  steps: { label: string; status: StepStatus }[] | null
  /** The button; null while a run goes and there is nothing to tap. */
  primary: { label: string; action: FinishAction } | null
}

const TITLE = 'Finish on your server'
const RUN_INTRO = 'On your server, as the user that runs Hermes, run:'
const TURNED_OFF_INTRO = `The plugin is on your server but turned off. ${RUN_INTRO}`
const NOT_LOADED = 'Hermes has not loaded the Ergates plugin yet.'
const RESTART_INTRO = {
  none: NOT_LOADED,
  update: 'The update is installed. Restart Hermes to start the new version.',
  go_back: 'The previous version is installed. Restart Hermes to start it.'
} as const
const DID_NOT_START = 'The new version did not start.'
const WENT_BACK_OUTDATED = 'The previous version is back, but this app needs a newer plugin. The update did not start on your server.'
const WENT_BACK_GUIDE = 'The guide shows what to check before you try again.'
const WENT_BACK_READY = 'The previous version is back. Your server is ready.'
const GO_BACK_BY_HAND = 'To go back yourself, run this on your server, as the user that runs Hermes:'
const CANNOT_GO_BACK = 'The update changed how Ergates keeps its data, so the previous version cannot be put back.'
const GOING_BACK = 'Going back to the previous version…'
const GUIDE_LABEL = 'Open the guide'
const CHECKING = 'Checking…'
const WAITING = 'Waiting for your server…'
const READY = 'Your server is ready.'
const SIGNED_OUT = 'Your server restarted. Sign in again to continue.'
const UNEXPECTED_PROBLEM = 'Could not set up your agents.'

// Hermes installs no service for `hermes serve`; the units it knows are hermes-dashboard and hermes-serve.
const RESTART_LINES: readonly string[] = [
  'Hermes service: systemctl --user restart hermes-dashboard (or hermes-serve)',
  'Docker: docker restart <container name>',
  'Hermes Desktop: quit it and open it again',
  'Started by hand: stop hermes serve and start it again'
]

const CHECK = { label: 'Check now', action: 'check' } as const
const GO_BACK = { label: 'Go back to the previous version', action: 'go_back' } as const
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
 *
 * `update` is what the screen knows about an update the app started. With
 * one under way, a plugin that does not come up after the restart is a new
 * version that did not start. A working plugin that still has an update is
 * named only when the app's own run ended by hand.
 *
 * `setupWaits` is true when the last ready check left the pending setup
 * waiting for other code than the code that answers: the ready server then
 * still needs the restart that starts it. When that check still offers an
 * update, no restart starts the code the setup waits for: the update has to
 * be installed first, so the page shows the update instead. After a go back
 * the offer is the update that did not start, and the restart stays.
 */
export function finishVariant(check: ServerCheck | null, manual: FinishManual | null, update: FinishUpdate = NO_UPDATE, setupWaits = false): FinishVariant | null {
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
      return afterUpdate(update) ?? { kind: 'restart', after: null }
    case 'restart_needed':
      return restartVariant(update, check)
    case 'unavailable':
      return afterUpdate(update)
    case 'outdated':
      // The update the app tried did not start, and its command is no way forward: the guide says what to check first.
      return showsWentBack(check, update.wentBack) ? { kind: 'went_back' } : updateVariant(check.installKind)
    case 'ready':
      if (setupWaits) {
        return check.update !== null && !showsWentBack(check, update.wentBack) ? { kind: 'update' } : restartVariant(update, check)
      }
      if (showsWentBack(check, update.wentBack)) {
        return { kind: 'went_back' }
      }
      return check.update !== null && update.byHand ? { kind: 'update' } : null
    case 'app_outdated':
    case 'unknown':
      return null
  }
}

/**
 * The restart that starts the code on the server: the previous version the
 * app put back, or else an update, whoever installed it (the files on the
 * server are newer than the code that answers).
 */
function restartVariant(update: FinishUpdate, check: ServerCheck): FinishVariant {
  return { kind: 'restart', after: showsWentBack(check, update.wentBack) ? 'go_back' : 'update' }
}

/**
 * The variant for a plugin that does not answer while an update the app
 * started is under way, or after the app put the previous version back, or
 * null outside both.
 */
function afterUpdate(update: FinishUpdate): FinishVariant | null {
  const { started } = update
  if (started === undefined) {
    // A go back ended the update; the failed version's routes answer until Hermes restarts, and the restart starts the previous version.
    return update.wentBack !== undefined ? { kind: 'restart', after: 'go_back' } : null
  }
  // Until the server went away, a plugin that does not answer is the restart the update asked for, not a new version that failed to start.
  if (update.awaitingRestart) {
    return { kind: 'restart', after: 'update' }
  }
  return { kind: 'not_started', previous: started.previous, goBack: COMMIT_PATTERN.test(started.previous) && canGoBack(started, update.schemaSeen) }
}

/**
 * Whether the previous version can still use the store: not when a health
 * read showed the store's oldest usable plugin schema above the one the
 * previous version writes. When either is unknown it counts as yes, because
 * the store's own marker makes an older plugin read-only instead of letting it
 * write a store it does not understand.
 */
function canGoBack(started: NonNullable<Connection['pluginUpdate']>, schemaSeen: number | null): boolean {
  return started.previousSchema === null || schemaSeen === null || schemaSeen <= started.previousSchema
}

/** What `runUpdate` takes to put the previous version back: it installs the commit the server had, and is a going back. */
export function goBackTarget(started: NonNullable<Connection['pluginUpdate']>): UpdateTarget {
  return { target: started.previous, goingBack: true }
}

/**
 * Whether the page still asks the user to update by hand although the server
 * answers: the plugin works and has an update, and this page is the update
 * variant. The page then keeps its instructions and keeps waiting.
 */
export function updateStillOpen(variant: FinishVariant | null, check: ServerCheck | null): boolean {
  return variant?.kind === 'update' && check?.kind === 'ready' && check.update !== null
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
 * has no answer yet. A restart installs nothing, and neither does an outdated
 * plugin that is the previous version the app put back
 * (`wentBack`): the page does not ask to install the failed update again.
 */
export function pendingCommit(check: ServerCheck | null, build: BuildRecord | null, wentBack: Connection['pluginWentBack'] = undefined): string | null {
  const outdatedToUpdate = check?.kind === 'outdated' && !showsWentBack(check, wentBack)
  const needsSetup = check?.kind === 'missing' || check?.kind === 'disabled' || outdatedToUpdate
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
  if (variant?.kind === 'not_started') {
    return variant.goBack ? '#manual' : '#restart'
  }
  switch (variant?.kind) {
    case undefined:
      return ''
    case 'restart':
      return '#restart'
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
      return { intro: [RESTART_INTRO[variant.after ?? 'none']], command: null, restart: true }
    case 'not_started':
      return notStarted(variant)
    case 'went_back':
      return { intro: [WENT_BACK_OUTDATED, WENT_BACK_GUIDE], command: null, restart: false }
  }
}

/** Going back by hand needs the full hash the app recorded; the app's own go back checks it again. */
function notStarted(variant: Extract<FinishVariant, { kind: 'not_started' }>): Instructions {
  if (!variant.goBack) {
    return { intro: [DID_NOT_START, CANNOT_GO_BACK], command: null, restart: true }
  }
  const command = COMMIT_PATTERN.test(variant.previous) ? installCommand(variant.previous, true) : null
  return { intro: [DID_NOT_START, GO_BACK_BY_HAND], command, restart: true }
}

function statusOf(variant: FinishVariant | null, check: ServerCheck | null, setup: SetupProgress): string {
  if (check === null) {
    return CHECKING
  }
  if (check.kind === 'ready') {
    // A ready server is not done until the plugin's setup went through: it is still being asked, or it said no. An update the user has yet to do, or a setup that waits for the new code, keeps it waiting.
    if (updateStillOpen(variant, check) || setup.state === 'waiting') {
      return WAITING
    }
    return setup.state === 'failed' ? setup.message : CHECKING
  }
  // During an update the page already says what to do.
  const updating = variant?.kind === 'not_started' || (variant?.kind === 'restart' && variant.after === 'update')
  if ((check.kind === 'app_outdated' || check.kind === 'unavailable') && !updating) {
    return pluginNotice(check)?.text ?? WAITING
  }
  return WAITING
}

/** What a finished go back that did not work says in the status line, or null when the status line says what the server says. */
function runStatus(outcome: UpdateOutcome | null): string | null {
  switch (outcome?.kind) {
    case 'failed':
      return outcome.message
    case 'manual':
      return failureLine(outcome.failure, outcome.detail)
    default:
      return null
  }
}

/**
 * The page for a variant and the latest check. `variant` is null until the
 * screen knows one. `check` is `'sign_in'` when the server refused the
 * session, which shows only that and the way to stay signed in. `setup` says
 * how the plugin's setup went after the server answered: the page is done
 * only when it went through, and stays done whatever a later check says; a
 * failure shows its message while the server is ready, and the next ready
 * check tries again. `run` is the go back the user started: its steps show
 * next to everything else, nothing is offered while it goes, and a run that
 * failed says so in the status line.
 *
 * Once the server answers (ready), asks for a new sign-in, or the setup is
 * done, the intro, the command and the restart lines are gone: the user did
 * what they were asked. A working plugin that still has an update the user
 * has to do by hand keeps them, and so does a ready server whose pending
 * setup waits for the new code (`setup` is `waiting`).
 */
export function finishView(
  variant: FinishVariant | null,
  build: BuildRecord | null,
  check: ServerCheck | 'sign_in' | null,
  setup: SetupProgress = { state: 'pending' },
  run: UpdateRunState | null = null
): FinishView {
  const guide = { label: GUIDE_LABEL, url: `${SERVER_GUIDE_URL}${anchorOf(variant)}` }
  const steps = run === null ? null : updateSteps(run, true)
  if (setup.state === 'done') {
    return { title: TITLE, intro: [], command: null, restartLines: null, guide, status: variant?.kind === 'went_back' ? WENT_BACK_READY : READY, done: true, steps, primary: DONE }
  }
  if (check === 'sign_in') {
    return {
      title: TITLE,
      intro: [],
      command: null,
      restartLines: null,
      guide: { label: SIGNED_OUT_HINT.label, url: SIGNED_OUT_HINT.url },
      status: `${SIGNED_OUT} ${SIGNED_OUT_HINT.text}`,
      done: false,
      steps,
      primary: SIGN_IN
    }
  }
  if (runIsGoing(run)) {
    return { title: TITLE, intro: [], command: null, restartLines: null, guide, status: GOING_BACK, done: false, steps, primary: null }
  }
  const status = runStatus(run?.outcome ?? null) ?? statusOf(variant, check, setup)
  if (variant === null || (check?.kind === 'ready' && !updateStillOpen(variant, check) && setup.state !== 'waiting')) {
    return { title: TITLE, intro: [], command: null, restartLines: null, guide, status, done: false, steps, primary: CHECK }
  }
  const { intro, command, restart } = instructionsFor(variant, build)
  const primary = variant.kind === 'not_started' && variant.goBack ? GO_BACK : CHECK
  return { title: TITLE, intro, command, restartLines: restart ? [...RESTART_LINES] : null, guide, status, done: false, steps, primary }
}

/** What a failed plugin setup shows in the status line: the gateway's own message, which carries no secrets. */
export function setupProblem(error: unknown): string {
  return isGatewayError(error) ? error.message : UNEXPECTED_PROBLEM
}
