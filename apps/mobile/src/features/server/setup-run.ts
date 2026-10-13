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
 * show up and fails only when the install time has passed.
 *
 * Plain async code over the gateway port, no React: screens call it and draw
 * the steps from `onStep`. The pending setup (see `pending-setup.ts`) is set
 * first and cleared only when the plugin's setup succeeded, so every way out
 * of the run but `done` leaves the setup to be finished later.
 */

import { isGatewayError, type GatewayError } from '@/gateway/errors'
import { PLUGIN_INSTALL_TIMEOUT_MS, type GatewayPort } from '@/gateway/port'
import type { PluginInstallCode, PluginProbe, SetupState } from '@/gateway/types'

import { PLUGIN_IDENTIFIER, PLUGIN_NAME, type BuildRecord } from './build-record'
import { clearPendingSetup, isSetupRunning, markPendingSetup, trackSetupRun } from './pending-setup'
import { hubRow } from './server-check'

/** Whether a run is going for the connection; `pending-setup.ts` owns the answer so that it can check it without importing this module. */
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

const RECHECK_MS = 5_000
const START_PROBES = 3
const START_WAIT_MS = 2_000
const LOST_CONNECTION = 'Lost the connection to your server during setup.'
const NOT_LOADED = 'Hermes did not load the plugin.'
const UNEXPECTED = 'Something went wrong during setup.'

const KNOWN_FAILURES: readonly ManualFailure[] = ['scan_blocked', 'no_git', 'download_failed', 'enable_refused']

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/** The refusal an install error stands for, or null when the install may have gone on without us. */
function manualFailure(error: GatewayError): ManualFailure | null {
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

function outcomeOfError(error: unknown, step: SetupStep | null): SetupOutcome {
  if (!isGatewayError(error)) {
    return { kind: 'failed', step: step ?? 'install', message: UNEXPECTED }
  }
  return error.kind === 'unauthorized' ? { kind: 'sign_in' } : { kind: 'failed', step: step ?? 'install', message: error.message }
}

class SetupRun {
  private readonly port: GatewayPort
  private readonly commit: string
  private readonly connectionId: string
  private readonly onStep: (step: SetupStep, status: StepStatus) => void
  /** The step that has begun and not ended. */
  private active: SetupStep | null = null
  /** False once the server is known to have the plugin enabled. */
  private needsEnable = true

  constructor(deps: SetupDeps, commit: string, onStep: (step: SetupStep, status: StepStatus) => void) {
    this.port = deps.port
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
    if (probe.state !== 'absent') {
      // Hermes serves the plugin, or has it enabled and has not mounted it yet.
      this.needsEnable = false
      this.end('install', 'skipped')
      return null
    }
    const row = await hubRow(this.port)
    if (row) {
      this.needsEnable = row.runtime_status !== 'enabled'
      this.end('install', 'skipped')
      return null
    }
    return this.requestInstall()
  }

  private async requestInstall(): Promise<SetupOutcome | null> {
    const startedAt = Date.now()
    try {
      const { enabled } = await this.port.plugins.install({ identifier: PLUGIN_IDENTIFIER, ref: this.commit, enable: true, force: false })
      this.needsEnable = !enabled
    } catch (error) {
      return this.afterInstallError(error, startedAt)
    }
    this.end('install', 'done')
    return null
  }

  private async afterInstallError(error: unknown, startedAt: number): Promise<SetupOutcome | null> {
    if (!isGatewayError(error)) {
      throw error
    }
    if (error.code === 'already_installed') {
      // Another phone or an earlier try got there first: carry on with what is on the server now.
      this.needsEnable = (await hubRow(this.port))?.runtime_status !== 'enabled'
      this.end('install', 'done')
      return null
    }
    const failure = manualFailure(error)
    if (failure !== null) {
      return { kind: 'manual', failure, detail: failure === 'refused' ? error.message : null }
    }
    if (isLost(error)) {
      return this.waitForPlugin(startedAt)
    }
    throw error
  }

  /** Looks again right away and then every few seconds, until the plugin shows up or the install time since the request began has passed. */
  private async waitForPlugin(startedAt: number): Promise<SetupOutcome | null> {
    for (;;) {
      if (await this.arrived()) {
        this.end('install', 'done')
        return null
      }
      if (Date.now() - startedAt >= PLUGIN_INSTALL_TIMEOUT_MS) {
        return { kind: 'failed', step: 'install', message: LOST_CONNECTION }
      }
      await sleep(RECHECK_MS)
    }
  }

  /** Whether the server has the plugin now. A read that fails counts as not yet; only a 401 stops the wait. */
  private async arrived(): Promise<boolean> {
    const probe = await this.probe()
    if (probe.state !== 'absent') {
      this.needsEnable = false
      return true
    }
    const row = await hubRow(this.port)
    if (!row) {
      return false
    }
    this.needsEnable = row.runtime_status !== 'enabled'
    return true
  }

  private async probe(): Promise<PluginProbe> {
    try {
      return await this.port.ergates.health()
    } catch (error) {
      if (isGatewayError(error) && error.kind !== 'unauthorized') {
        return { state: 'absent' }
      }
      throw error
    }
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
    for (let probes = 1; probes <= START_PROBES; probes += 1) {
      const found = await this.port.ergates.health()
      if (found.state === 'answered') {
        this.end('start', 'done')
        return null
      }
      if (found.state === 'not_loaded') {
        return { kind: 'restart' }
      }
      if (probes < START_PROBES) {
        await sleep(START_WAIT_MS)
      }
    }
    return { kind: 'failed', step: 'start', message: NOT_LOADED }
  }

  private async setup(): Promise<SetupOutcome> {
    this.begin('setup')
    const report = await this.port.ergates.setup()
    clearPendingSetup(this.connectionId)
    this.end('setup', 'done')
    return { kind: 'done', setup: report }
  }
}

interface Flight {
  promise: Promise<SetupOutcome>
  /** The latest status of each step that has reported, in the order the steps first reported. */
  statuses: Map<SetupStep, StepStatus>
  listeners: ((step: SetupStep, status: StepStatus) => void)[]
}

/** The run that is going for each connection. */
const flights = new Map<string, Flight>()

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
 * One run goes at a time per connection. A call while one is going joins it
 * (the port and build of the call are not used): `onStep` first gets the
 * latest status of every step that has reported, then every later transition,
 * and the promise settles with the same outcome. The call after the run ended
 * starts a new one.
 */
export async function runSetup(deps: SetupDeps, onStep: (step: SetupStep, status: StepStatus) => void): Promise<SetupOutcome> {
  const going = flights.get(deps.connectionId)
  if (going) {
    going.statuses.forEach((status, step) => onStep(step, status))
    going.listeners.push(onStep)
    return going.promise
  }
  manualOutcomes.delete(deps.connectionId)
  const { commit } = deps.build.requiredPlugin
  if (commit === null) {
    return rememberManual(deps.connectionId, { kind: 'manual', failure: 'refused', detail: null })
  }
  const statuses = new Map<SetupStep, StepStatus>()
  const listeners = [onStep]
  // Remembered before the outcome reaches anything that waits for it, so a screen opened by it finds it.
  const promise = new SetupRun(deps, commit, (step, status) => {
    statuses.set(step, status)
    listeners.forEach(listener => listener(step, status))
  })
    .execute()
    .then(outcome => rememberManual(deps.connectionId, outcome))
  flights.set(deps.connectionId, { promise, statuses, listeners })
  trackSetupRun(deps.connectionId, promise)
  const forget = () => {
    flights.delete(deps.connectionId)
  }
  void promise.then(forget, forget)
  return promise
}
