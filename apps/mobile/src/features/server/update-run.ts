/**
 * The run behind "Update": replace the Ergates plugin on a server with the
 * commit this build carries, or put the previous commit back (going back is
 * the same run with another commit). Hermes replaces a plugin over its REST
 * route only while the plugin is turned off, so the run turns it off, installs
 * over it, and checks what answers. A Hermes that does not remount routes
 * keeps answering with the old code until it restarts; the run then ends with
 * `restart` and the pending setup waits for the new code (`pending-setup.ts`).
 *
 * A run that ends before the install is confirmed turns the old plugin back
 * on, so a refused or lost update never leaves the server without it.
 *
 * Plain async code over the gateway port, no React: screens call it and draw
 * the steps from `onStep`. The update and the pending setup are recorded
 * before anything changes on the server and cleared only when the plugin's
 * setup succeeded.
 */

import { isGatewayError, type GatewayError } from '@/gateway/errors'
import type { GatewayPort } from '@/gateway/port'
import type { PluginProbe, SetupState } from '@/gateway/types'
import { useDeviceStore } from '@/state/device-store'

import { COMMIT_PATTERN, PLUGIN_IDENTIFIER, PLUGIN_NAME, type BuildRecord } from './build-record'
import { parseHermesVersion } from './hermes-version'
import { clearPendingSetupIfUnchanged, isGoingBack, markPendingSetup, pendingSnapshot, runningKind } from './pending-setup'
import { Flights } from './run-flights'
import { hermesVersionOf, hubRow } from './server-check'
import { installAndWait, manualFailure, NOT_LOADED, probeHealth, waitForRoutes, type ManualOutcome, type StepStatus } from './setup-run'

export type UpdateStep = 'pause' | 'install' | 'start' | 'setup'

export type UpdateOutcome =
  | { kind: 'done'; setup: SetupState }
  /** The new plugin is installed and on, but Hermes still answers with the old code: Hermes needs a restart. */
  | { kind: 'restart' }
  | ManualOutcome
  | { kind: 'sign_in' }
  | { kind: 'failed'; step: UpdateStep; message: string }

export interface UpdateDeps {
  port: GatewayPort
  build: BuildRecord
  connectionId: string
  /** The commit to install: this build's, or when `goingBack` the commit the server had before the update. */
  target: string
  /** The commit the server has now. */
  previous: string
  /** The store schema the plugin on the server writes, or null when it does not say. */
  previousSchema: number | null
  goingBack: boolean
}

const LOST_CONNECTION = 'Lost the connection to your server during the update.'
const UNEXPECTED = 'Something went wrong during the update.'
const SETUP_RUNNING = 'Setting up this server is running. Try again when it is done.'
const UPDATE_RUNNING = 'An update is running. Try again when it is done.'
const GOING_BACK_RUNNING = 'Going back is running. Try again when it is done.'

function outcomeOfError(error: unknown, step: UpdateStep | null): UpdateOutcome {
  if (!isGatewayError(error)) {
    return { kind: 'failed', step: step ?? 'pause', message: UNEXPECTED }
  }
  return error.kind === 'unauthorized' ? { kind: 'sign_in' } : { kind: 'failed', step: step ?? 'pause', message: error.message }
}

/** The outcome for a 400 on the install: Hermes said no, in a code the app knows or in words of its own. Null for any other error. */
function refusal(error: GatewayError): ManualOutcome | null {
  const failure = manualFailure(error) ?? (error.status === 400 ? 'refused' : null)
  return failure === null ? null : { kind: 'manual', failure, detail: failure === 'refused' ? error.message : null }
}

class UpdateRun {
  private readonly port: GatewayPort
  private readonly connectionId: string
  private readonly target: string
  private readonly previous: string
  private readonly previousSchema: number | null
  private readonly goingBack: boolean
  private readonly onStep: (step: UpdateStep, status: StepStatus) => void
  /** The step that has begun and not ended. */
  private active: UpdateStep | null = null
  /** What the plugin said before it was turned off. */
  private before: PluginProbe = { state: 'absent' }
  /** True from the moment the plugin may be turned off until the install is known to have left it on. */
  private mayBeOff = false

  constructor(deps: UpdateDeps, onStep: (step: UpdateStep, status: StepStatus) => void) {
    this.port = deps.port
    this.connectionId = deps.connectionId
    this.target = deps.target
    this.previous = deps.previous
    this.previousSchema = deps.previousSchema
    this.goingBack = deps.goingBack
    this.onStep = onStep
  }

  async execute(): Promise<UpdateOutcome> {
    let outcome: UpdateOutcome
    try {
      outcome = (await this.pause()) ?? (await this.install()) ?? (await this.start()) ?? (await this.setup())
    } catch (error) {
      outcome = outcomeOfError(error, this.active)
    }
    if (this.mayBeOff) {
      await this.turnBackOn()
    }
    if (outcome.kind !== 'done' && this.active !== null) {
      this.onStep(this.active, 'failed')
      this.active = null
    }
    return outcome
  }

  /**
   * Remembers the update (going back leaves the update it undoes in place) and
   * the setup that waits for the new code. This comes after the first look at
   * the plugin, so a run that cannot even look leaves nothing behind.
   */
  private record(): void {
    if (!this.goingBack) {
      useDeviceStore.getState().updateConnection(this.connectionId, { pluginUpdate: { target: this.target, previous: this.previous, previousSchema: this.previousSchema } })
    }
    markPendingSetup(this.connectionId, this.target)
  }

  private begin(step: UpdateStep): void {
    this.active = step
    this.onStep(step, 'active')
  }

  private end(step: UpdateStep): void {
    this.active = null
    this.onStep(step, 'done')
  }

  /** Each step returns the outcome that ends the run, or null to go on to the next. */
  private async pause(): Promise<UpdateOutcome | null> {
    this.begin('pause')
    // Whether routes were mounted before is what tells a remount from a first mount, so it is read before anything changes.
    this.before = await probeHealth(this.port)
    this.record()
    this.mayBeOff = true
    await this.port.plugins.disable(PLUGIN_NAME)
    this.end('pause')
    return null
  }

  private async install(): Promise<UpdateOutcome | null> {
    this.begin('install')
    const end = await installAndWait(
      () => this.port.plugins.install({ identifier: PLUGIN_IDENTIFIER, ref: this.target, enable: true, force: true }),
      () => this.targetIsOn()
    )
    switch (end.kind) {
      case 'answered':
        if (!end.result.enabled) {
          const refused = await this.enableInstalled()
          if (refused !== null) {
            return refused
          }
        }
        break
      case 'rejected': {
        const outcome = refusal(end.error)
        if (outcome === null) {
          throw end.error
        }
        return outcome
      }
      case 'lost':
        return { kind: 'failed', step: 'install', message: LOST_CONNECTION }
      case 'seen':
        break
    }
    this.mayBeOff = false
    this.end('install')
    return null
  }

  /** Whether the install record names the target and Hermes lists the plugin as enabled. The record can be read only from a plugin that answers. */
  private async targetIsOn(): Promise<boolean> {
    const probe = await probeHealth(this.port)
    if (probe.state !== 'answered' || probe.health.install?.commit !== this.target) {
      return false
    }
    return (await hubRow(this.port))?.runtime_status === 'enabled'
  }

  /** Turns on a plugin the install left off. Hermes saying no in words of its own ends the run in the manual path. */
  private async enableInstalled(): Promise<UpdateOutcome | null> {
    try {
      await this.port.plugins.enable(PLUGIN_NAME)
    } catch (error) {
      if (isGatewayError(error) && error.status === 400) {
        return { kind: 'manual', failure: 'enable_refused', detail: error.message }
      }
      throw error
    }
    return null
  }

  private async start(): Promise<UpdateOutcome | null> {
    this.begin('start')
    let found: PluginProbe
    try {
      found = await waitForRoutes(this.port)
    } catch (error) {
      // Code that cannot open its store answers 503 until Hermes restarts: that is a restart to ask for, not a failure.
      if (isGatewayError(error) && error.code === 'store_unavailable') {
        return { kind: 'restart' }
      }
      throw error
    }
    if (found.state === 'not_loaded') {
      return { kind: 'restart' }
    }
    if (found.state === 'absent') {
      return { kind: 'failed', step: 'start', message: NOT_LOADED }
    }
    if (found.health.install?.loaded_commit !== this.target) {
      return { kind: 'restart' }
    }
    await this.learnRemount()
    this.end('start')
    return null
  }

  /**
   * Notes the Hermes version when the new code answers without a restart.
   * That is only a remount when routes were mounted before the update and
   * did not already run the target.
   */
  private async learnRemount(): Promise<void> {
    const { before } = this
    const mountedBefore = before.state === 'answered' && before.health.install?.loaded_commit !== this.target
    const known = useDeviceStore.getState().connections.find(connection => connection.id === this.connectionId)?.pluginRemountsFrom
    if (!mountedBefore || known !== undefined) {
      return
    }
    const version = await hermesVersionOf(this.port)
    if (version !== null && parseHermesVersion(version) !== null) {
      useDeviceStore.getState().updateConnection(this.connectionId, { pluginRemountsFrom: version })
    }
  }

  private async setup(): Promise<UpdateOutcome> {
    this.begin('setup')
    const seen = pendingSnapshot(this.connectionId)
    const report = await this.port.ergates.setup()
    clearPendingSetupIfUnchanged(this.connectionId, seen)
    this.end('setup')
    return { kind: 'done', setup: report }
  }

  /** Best effort: the outcome of the run already says what went wrong, and a second failure adds nothing the user can act on. */
  private async turnBackOn(): Promise<void> {
    try {
      await this.port.plugins.enable(PLUGIN_NAME)
    } catch {
      // Left off; the next check shows the plugin as turned off and offers to turn it on.
    }
  }
}

const flights = new Flights<UpdateStep, StepStatus, UpdateOutcome>('update')

/** How the last run of each connection ended. Kept in memory only. */
const outcomes = new Map<string, UpdateOutcome>()

/**
 * The outcome of the connection's last update run, or null: no run has gone
 * since the app started, or a new run has begun. The Finish screen reads it to
 * say why the update stopped. It is not in the route, because the text of a
 * route is anyone's to write.
 */
export function lastUpdateOutcome(connectionId: string): UpdateOutcome | null {
  return outcomes.get(connectionId) ?? null
}

function remember(connectionId: string, outcome: UpdateOutcome): UpdateOutcome {
  outcomes.set(connectionId, outcome)
  return outcome
}

/**
 * The app installs the commit of its own build, or, going back, the commit it
 * recorded itself when it started the update; anything else is the user's to
 * install.
 */
function installable({ build, connectionId, target, goingBack }: UpdateDeps): boolean {
  if (!COMMIT_PATTERN.test(target)) {
    return false
  }
  return goingBack ? pendingSnapshot(connectionId).update?.previous === target : target === build.requiredPlugin.commit
}

/** The commit the connection's latest update run installs. Read only while that run is going, so an old entry is never taken for the current one. */
const latest = new Map<string, string>()

/**
 * Replaces the plugin on the server with `target` and says how it went.
 * `onStep` reports each step's transitions; no step is left `active` when the
 * run returns. Unless `goingBack`, the update (`target`, `previous`,
 * `previousSchema`) is recorded on the connection until the plugin's setup ran.
 * A target the app may not install is answered with the manual path before
 * anything else happens.
 *
 * One run goes at a time per connection. A call for the update that is going
 * joins it (the other arguments of the call are not used): `onStep` first gets
 * the latest status of every step that has reported, then every later
 * transition, and the promise settles with the same outcome. A call for
 * another target, or while a setup is going, touches nothing and fails with a
 * message that names the run that is going.
 */
export function runUpdate(deps: UpdateDeps, onStep: (step: UpdateStep, status: StepStatus) => void): Promise<UpdateOutcome> {
  const { connectionId, target, goingBack } = deps
  const kind = runningKind(connectionId)
  if (kind === 'setup') {
    return Promise.resolve({ kind: 'failed', step: 'pause', message: SETUP_RUNNING })
  }
  if (kind === 'update') {
    if (latest.get(connectionId) !== target || isGoingBack(connectionId) !== goingBack) {
      return Promise.resolve({ kind: 'failed', step: 'pause', message: isGoingBack(connectionId) ? GOING_BACK_RUNNING : UPDATE_RUNNING })
    }
    return flights.join(connectionId, onStep) ?? Promise.resolve({ kind: 'failed', step: 'pause', message: UPDATE_RUNNING })
  }
  outcomes.delete(connectionId)
  if (!installable(deps)) {
    return Promise.resolve(remember(connectionId, { kind: 'manual', failure: 'refused', detail: null }))
  }
  latest.set(connectionId, target)
  // Remembered before the outcome reaches anything that waits for it, so a screen opened by it finds it.
  return flights.start(connectionId, onStep, report => new UpdateRun(deps, report).execute().then(outcome => remember(connectionId, outcome)), goingBack)
}
