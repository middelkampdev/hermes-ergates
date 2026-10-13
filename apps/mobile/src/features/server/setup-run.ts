/**
 * The run behind "Set up this server": install the Ergates plugin, enable it,
 * wait until Hermes serves it, then run its setup once. Every run starts from
 * what the server says now, so a retry, a second phone or an app that came
 * back from sleep never installs twice: a plugin that is already there skips
 * the install, and one that is enabled skips the enable.
 *
 * An install answers only when it ends, and the phone or a proxy in between
 * may give up long before Hermes does. A request that was lost that way (no
 * answer, or a 5xx) is not a refusal: the run keeps waiting for the plugin to
 * show up and fails only when the install time has passed. A request that is
 * still pending after a minute does not hold the run either: the run starts
 * looking for the plugin and goes on as soon as it is there (`installAndWait`,
 * which the update run uses too).
 *
 * Plain async code over the gateway port, no React: screens call it and draw
 * the steps from `onStep`. The pending setup (see `pending-setup.ts`) is set
 * first and cleared only when the plugin's setup succeeded, so every way out
 * of the run but `done` leaves the setup to be finished later.
 */

import { isGatewayError, type GatewayError } from '@/gateway/errors'
import { PLUGIN_INSTALL_TIMEOUT_MS, type GatewayPort } from '@/gateway/port'
import type { PluginInstallCode, PluginInstallResult, PluginProbe, SetupState } from '@/gateway/types'

import { COMMIT_PATTERN, PLUGIN_IDENTIFIER, PLUGIN_NAME, type BuildRecord } from './build-record'
import { clearPendingSetupIfUnchanged, isSetupRunning, markPendingSetup, pendingSnapshot, runningKind } from './pending-setup'
import { Flights } from './run-flights'
import { hubRow, pluginPresence, waitsForRestart } from './server-check'

/** Whether a run of any kind is going for the connection, an update or going back too (`runningKind` says which); `pending-setup.ts` owns the answer so that it can check it without importing this module. */
export { isSetupRunning }

export type SetupStep = 'install' | 'enable' | 'start' | 'setup'
/** `pending` is a screen's state before a step begins; the run itself reports the other four. */
export type StepStatus = 'pending' | 'active' | 'done' | 'skipped' | 'failed'

/** Why the user has to install by hand: Hermes refused it, or (`refused`) refused it in words the app does not know. */
export type ManualFailure = Exclude<PluginInstallCode, 'already_installed'> | 'refused'

/** `detail` is Hermes's own text for `refused` and for an enable that was refused; null for the install failures the app knows. */
export type ManualOutcome = { kind: 'manual'; failure: ManualFailure; detail: string | null }

export type SetupOutcome =
  | { kind: 'done'; setup: SetupState }
  | ManualOutcome
  /** The plugin is enabled but Hermes does not serve its routes: Hermes needs a restart. */
  | { kind: 'restart' }
  | { kind: 'sign_in' }
  | { kind: 'failed'; step: SetupStep; message: string }

export interface SetupDeps {
  port: GatewayPort
  build: BuildRecord
  connectionId: string
}

/** How long an install request may be pending before the run starts looking for the plugin itself. */
export const INSTALL_RACE_AFTER_MS = 60_000
const RECHECK_MS = 5_000
const START_PROBES = 3
const START_WAIT_MS = 2_000
const LOST_CONNECTION = 'Lost the connection to your server during setup.'
/** What a run says when the plugin is installed and enabled but Hermes never serves it. */
export const NOT_LOADED = 'Hermes did not load the plugin.'
const UNEXPECTED = 'Something went wrong during setup.'
const UPDATE_RUNNING = 'The plugin is being updated. Try again when it is done.'

const KNOWN_FAILURES: readonly ManualFailure[] = ['scan_blocked', 'no_git', 'download_failed', 'enable_refused']

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/** Waits `ms`, or less when `done` settles first; the timer does not outlive the wait. */
function sleepUnless(ms: number, done: Promise<unknown>): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms)
    void done.then(() => {
      clearTimeout(timer)
      resolve()
    })
  })
}

/** The refusal an install error stands for, or null when the install may have gone on without us. */
export function manualFailure(error: GatewayError): ManualFailure | null {
  const known = KNOWN_FAILURES.find(code => code === error.code)
  if (known !== undefined) {
    return known
  }
  return error.status === 400 && error.code === undefined ? 'refused' : null
}

/** An install request that got no answer, or one a proxy answered for Hermes: the install may still be running. */
function isLost(error: GatewayError): boolean {
  return error.kind === 'network' || error.kind === 'timeout' || (error.status !== undefined && error.status >= 500)
}

/** How an install request ended for the run that sent it. */
export type InstallEnd =
  | { kind: 'answered'; result: PluginInstallResult }
  /** Hermes answered with an error that is not a lost request: the caller decides what it means. */
  | { kind: 'rejected'; error: GatewayError }
  /** The request did not answer, but `seen` found the plugin: the request is abandoned and its answer, if one comes, is ignored. */
  | { kind: 'seen' }
  /** The install time passed without an answer and without the plugin showing up. */
  | { kind: 'lost' }

type Reply = { ok: true; result: PluginInstallResult } | { ok: false; error: unknown }

/**
 * Sends the install and waits for what ends it. An install answers only when
 * it ends, so a request can be pending long after the server has the plugin
 * (a proxy that never answers, a phone that went to sleep). Once the request
 * has been pending for `INSTALL_RACE_AFTER_MS`, and again right after it was
 * lost (no answer, a timeout or a 5xx), `seen` is asked every few seconds
 * until it says yes or the install time since the request began has passed.
 * `seen` rejects only with a 401, which ends the wait with that error. An
 * error that is not a `GatewayError` is rethrown.
 */
export async function installAndWait(request: () => Promise<PluginInstallResult>, seen: () => Promise<boolean>): Promise<InstallEnd> {
  const startedAt = Date.now()
  const received: { reply: Reply | null } = { reply: null }
  const answered = request().then(
    result => {
      received.reply = { ok: true, result }
    },
    (error: unknown) => {
      received.reply = { ok: false, error }
    }
  )
  for (;;) {
    const elapsed = Date.now() - startedAt
    const { reply } = received
    if (reply === null && elapsed < INSTALL_RACE_AFTER_MS) {
      await sleepUnless(INSTALL_RACE_AFTER_MS - elapsed, answered)
      continue
    }
    if (reply?.ok) {
      return { kind: 'answered', result: reply.result }
    }
    if (reply !== null) {
      if (!isGatewayError(reply.error)) {
        throw reply.error
      }
      if (!isLost(reply.error)) {
        return { kind: 'rejected', error: reply.error }
      }
    }
    if (await seen()) {
      return { kind: 'seen' }
    }
    if (elapsed >= PLUGIN_INSTALL_TIMEOUT_MS) {
      return { kind: 'lost' }
    }
    await (reply === null ? sleepUnless(RECHECK_MS, answered) : sleep(RECHECK_MS))
  }
}

/** The plugin's health read as a probe. A read that fails counts as not answered; only a 401 stops the caller. */
export async function probeHealth(port: GatewayPort): Promise<PluginProbe> {
  try {
    return await port.ergates.health()
  } catch (error) {
    if (isGatewayError(error) && error.kind !== 'unauthorized') {
      return { state: 'absent' }
    }
    throw error
  }
}

/**
 * Asks for the plugin's health up to three times, two seconds apart, until it
 * answers or Hermes says it does not serve the plugin. Returns the last
 * probe: `absent` means Hermes never served it.
 */
export async function waitForRoutes(port: GatewayPort): Promise<PluginProbe> {
  for (let probes = 1; ; probes += 1) {
    const found = await port.ergates.health()
    if (found.state !== 'absent' || probes === START_PROBES) {
      return found
    }
    await sleep(START_WAIT_MS)
  }
}

function outcomeOfError(error: unknown, step: SetupStep | null): SetupOutcome {
  if (!isGatewayError(error)) {
    return { kind: 'failed', step: step ?? 'install', message: UNEXPECTED }
  }
  return error.kind === 'unauthorized' ? { kind: 'sign_in' } : { kind: 'failed', step: step ?? 'install', message: error.message }
}

class SetupRun {
  private readonly port: GatewayPort
  private readonly build: BuildRecord
  private readonly commit: string
  private readonly connectionId: string
  private readonly onStep: (step: SetupStep, status: StepStatus) => void
  /** The step that has begun and not ended. */
  private active: SetupStep | null = null
  /** False once the server is known to have the plugin enabled. */
  private needsEnable = true

  constructor(deps: SetupDeps, commit: string, onStep: (step: SetupStep, status: StepStatus) => void) {
    this.port = deps.port
    this.build = deps.build
    this.connectionId = deps.connectionId
    this.commit = commit
    this.onStep = onStep
  }

  async execute(): Promise<SetupOutcome> {
    markPendingSetup(this.connectionId, this.commit)
    let outcome: SetupOutcome
    try {
      outcome = (await this.install()) ?? (await this.enable()) ?? (await this.start()) ?? (await this.setup())
    } catch (error) {
      outcome = outcomeOfError(error, this.active)
    }
    if (outcome.kind !== 'done' && this.active !== null) {
      this.onStep(this.active, 'failed')
      this.active = null
    }
    return outcome
  }

  private begin(step: SetupStep): void {
    this.active = step
    this.onStep(step, 'active')
  }

  private end(step: SetupStep, status: 'done' | 'skipped'): void {
    this.active = null
    this.onStep(step, status)
  }

  /** Each step returns the outcome that ends the run, or null to go on to the next. */
  private async install(): Promise<SetupOutcome | null> {
    this.begin('install')
    const probe = await this.port.ergates.health()
    this.follow(probe)
    const presence = await pluginPresence(this.port, probe)
    if (presence.there) {
      this.needsEnable = presence.enabled === false
      this.end('install', 'skipped')
      return null
    }
    return this.requestInstall()
  }

  /**
   * Points the pending setup at the commit the answering code was loaded
   * from, so that the flag names code that can load: the plugin already on the
   * server may be another commit than this build's. Code that is older than
   * the files on the server is left alone, because the setup belongs to the
   * commit that loads after the restart.
   */
  private follow(probe: PluginProbe): void {
    if (probe.state !== 'answered' || waitsForRestart(probe.health, this.build)) {
      return
    }
    const { install } = probe.health
    const loaded = install?.kind === 'git install' ? install.loaded_commit : undefined
    if (typeof loaded === 'string' && COMMIT_PATTERN.test(loaded)) {
      markPendingSetup(this.connectionId, loaded)
    }
  }

  private async requestInstall(): Promise<SetupOutcome | null> {
    const end = await installAndWait(
      () => this.port.plugins.install({ identifier: PLUGIN_IDENTIFIER, ref: this.commit, enable: true, force: false }),
      () => this.arrived()
    )
    switch (end.kind) {
      case 'answered':
        this.needsEnable = !end.result.enabled
        break
      case 'rejected': {
        const outcome = await this.afterRefusal(end.error)
        if (outcome !== null) {
          return outcome
        }
        break
      }
      case 'lost':
        return { kind: 'failed', step: 'install', message: LOST_CONNECTION }
      case 'seen':
        break
    }
    this.end('install', 'done')
    return null
  }

  /** The outcome that ends the run for an install error, or null when the install is as good as done. */
  private async afterRefusal(error: GatewayError): Promise<SetupOutcome | null> {
    if (error.code === 'already_installed') {
      // Another phone or an earlier try got there first: carry on with what is on the server now.
      this.needsEnable = (await hubRow(this.port))?.runtime_status !== 'enabled'
      return null
    }
    const failure = manualFailure(error)
    if (failure !== null) {
      return { kind: 'manual', failure, detail: failure === 'refused' ? error.message : null }
    }
    throw error
  }

  /** Whether the server has the plugin now. A read that fails counts as not yet; only a 401 stops the wait. */
  private async arrived(): Promise<boolean> {
    const presence = await pluginPresence(this.port, await probeHealth(this.port))
    if (presence.there) {
      this.needsEnable = presence.enabled === false
    }
    return presence.there
  }

  private async enable(): Promise<SetupOutcome | null> {
    if (!this.needsEnable) {
      this.onStep('enable', 'skipped')
      return null
    }
    this.begin('enable')
    try {
      await this.port.plugins.enable(PLUGIN_NAME)
    } catch (error) {
      // Hermes answered 400 and said no in words of its own: the user enables the plugin by hand.
      // Any other failure (no answer, a 5xx, a 403) may pass, so the step fails and the user can try again.
      if (isGatewayError(error) && error.status === 400) {
        return { kind: 'manual', failure: 'enable_refused', detail: error.message }
      }
      throw error
    }
    this.end('enable', 'done')
    return null
  }

  private async start(): Promise<SetupOutcome | null> {
    this.begin('start')
    const found = await waitForRoutes(this.port)
    if (found.state === 'answered') {
      // The files changed under the running code: its setup is not the new code's.
      if (waitsForRestart(found.health, this.build)) {
        return { kind: 'restart' }
      }
      this.follow(found)
      this.end('start', 'done')
      return null
    }
    return found.state === 'not_loaded' ? { kind: 'restart' } : { kind: 'failed', step: 'start', message: NOT_LOADED }
  }

  private async setup(): Promise<SetupOutcome> {
    this.begin('setup')
    const seen = pendingSnapshot(this.connectionId)
    const report = await this.port.ergates.setup()
    clearPendingSetupIfUnchanged(this.connectionId, seen)
    this.end('setup', 'done')
    return { kind: 'done', setup: report }
  }
}

const flights = new Flights<SetupStep, StepStatus, SetupOutcome>('setup')

/** How the last run of each connection ended when it ended in the manual path. Kept in memory only. */
const manualOutcomes = new Map<string, ManualOutcome>()

/**
 * The manual outcome of the connection's last run, or null: the run ended
 * otherwise, no run has gone since the app started, or a new run has begun.
 * The Finish screen reads it to say why the install is by hand. It is not in
 * the route, because the text of a route is anyone's to write.
 */
export function lastManualOutcome(connectionId: string): ManualOutcome | null {
  return manualOutcomes.get(connectionId) ?? null
}

function rememberManual(connectionId: string, outcome: SetupOutcome): SetupOutcome {
  if (outcome.kind === 'manual') {
    manualOutcomes.set(connectionId, outcome)
  }
  return outcome
}

/**
 * Brings the server to a plugin that is installed, enabled, served and set
 * up, and says how it went. `onStep` reports each step's transitions; a step
 * the server did not need ends as `skipped`, and no step is left `active` when
 * the run returns. The build must carry a commit to install: a build without
 * one is answered with the manual path before anything else happens.
 *
 * One run goes at a time per connection. A call while a setup is going joins
 * it (the port and build of the call are not used): `onStep` first gets the
 * latest status of every step that has reported, then every later transition,
 * and the promise settles with the same outcome. The call after the run ended
 * starts a new one. A call while an update is going touches nothing and fails
 * with a message that says so.
 */
export function runSetup(deps: SetupDeps, onStep: (step: SetupStep, status: StepStatus) => void): Promise<SetupOutcome> {
  const joined = flights.join(deps.connectionId, onStep)
  if (joined !== null) {
    return joined
  }
  if (runningKind(deps.connectionId) !== null) {
    return Promise.resolve({ kind: 'failed', step: 'install', message: UPDATE_RUNNING })
  }
  manualOutcomes.delete(deps.connectionId)
  const { commit } = deps.build.requiredPlugin
  if (commit === null) {
    return Promise.resolve(rememberManual(deps.connectionId, { kind: 'manual', failure: 'refused', detail: null }))
  }
  // Remembered before the outcome reaches anything that waits for it, so a screen opened by it finds it.
  return flights.start(deps.connectionId, onStep, report =>
    new SetupRun(deps, commit, report).execute().then(outcome => rememberManual(deps.connectionId, outcome))
  )
}
