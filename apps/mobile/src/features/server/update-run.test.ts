/**
 * The update run replaces the plugin on a server with the build's commit:
 * turn it off, install over it, check what answers, run the plugin's setup.
 * The tests drive it with FakeGateway, which refuses a forced install over a
 * plugin that is turned on and keeps the old code mounted after a
 * replacement, as Hermes does until it restarts.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'

import { GatewayError, mapErgatesError, mapHttpError } from '@/gateway/errors'
import { PLUGIN_INSTALL_TIMEOUT_MS } from '@/gateway/port'
import { mapPluginInstallError } from '@/gateway/real/plugins-api'
import type { ErgatesHealth, PluginInstallCode, PluginProbe } from '@/gateway/types'
import { useDeviceStore, type Connection } from '@/state/device-store'
import { FAKE_PLUGIN_COMMIT, FAKE_PLUGIN_HEALTH, FAKE_SETUP } from '@test/fake-gateway/fake-ergates'
import { FakeGateway } from '@test/fake-gateway/fake-gateway'

import { PLUGIN_IDENTIFIER, type BuildRecord } from './build-record'
import { finishUpdateOf, finishVariant, finishView, type SetupProgress } from './finish-view'
import { finishPendingSetup, markPendingSetup, runningKind } from './pending-setup'
import { NOT_WATCHED } from './restart-watch'
import type { ServerCheck } from './server-check'
import { INSTALL_RACE_AFTER_MS, isSetupRunning, runSetup, type StepStatus } from './setup-run'
import { joinUpdate, lastUpdateOutcome, lastUpdateRun, restartWatchOf, runUpdate, schemaSeenOf, watchUpdateRestart, watchUpdateSchema, type UpdateDeps, type UpdateOutcome, type UpdateStep } from './update-run'

const OLD = FAKE_PLUGIN_COMMIT
const TARGET = 'b'.repeat(40)
const LOST = 'Lost the connection to your server during the update.'
const NOT_LOADED = 'Hermes did not load the plugin.'

const connection: Connection = { id: 'c-1', label: 'Home server', baseUrl: 'http://100.64.0.1:9119', authMode: 'token', primary: true, createdAt: 1 }

function buildRecord(commit: string | null = TARGET): BuildRecord {
  return { requiredPlugin: { version: '0.3.0', apiLevel: 2, commit }, hermesRange: { oldest: '0.21.6', newestMinor: '0.21' } }
}

/** A server that runs the plugin at OLD, with the version that answers `status`. */
function runningServer(hermes = '0.21.7'): FakeGateway {
  const gateway = new FakeGateway()
  gateway.plugins.rows = [{ name: 'ergates', version: '0.2.0', runtime_status: 'enabled' }]
  gateway.setHermesVersion(hermes)
  return gateway
}

/** A server without the plugin whose health follows the plugin list, as a Hermes that mounts a plugin when it is enabled does. */
function emptyServer(): FakeGateway {
  const gateway = new FakeGateway()
  gateway.plugins.rows = []
  gateway.ergates.setHealth(() => (gateway.plugins.rows.some(found => found.name === 'ergates' && found.runtime_status === 'enabled') ? { state: 'answered', health: FAKE_PLUGIN_HEALTH } : { state: 'absent' }))
  return gateway
}

/** What the server holds when the install went through although the answer never came. */
function installedOnServer(gateway: FakeGateway, status: 'enabled' | 'disabled' = 'enabled'): void {
  gateway.plugins.installedCommit = TARGET
  gateway.plugins.rows[0].runtime_status = status
  gateway.ergates.loadedCommit = TARGET
}

/** Makes the server mount the new code at once when an install replaces the plugin, as a Hermes that remounts routes would. */
function remounting(gateway: FakeGateway): void {
  const install = gateway.plugins.install.bind(gateway.plugins)
  gateway.plugins.install = async req => {
    const result = await install(req)
    gateway.ergates.loadedCommit = req.ref
    return result
  }
}

/**
 * A health script whose first read (the run's first look) finds the plugin at OLD as `runningServer` has it,
 * and whose later reads find `later`.
 */
function afterTheFirstLook(later: PluginProbe | Error | (() => PluginProbe | Error)): () => PluginProbe | Error {
  let reads = 0
  return () => {
    reads += 1
    if (reads === 1) {
      return { state: 'answered', health: FAKE_PLUGIN_HEALTH }
    }
    return typeof later === 'function' ? later() : later
  }
}

/** A health script for going back: the first look finds the new version not started, the later reads find `later`. */
function notLoadedThen(later: PluginProbe): () => PluginProbe {
  let reads = 0
  return () => {
    reads += 1
    return reads === 1 ? { state: 'not_loaded' } : later
  }
}

/** Records the order of the calls that change the server. */
function watch(gateway: FakeGateway): { order: () => string[] } {
  const spies: [string, MockInstance][] = [
    ['disable', vi.spyOn(gateway.plugins, 'disable')],
    ['install', vi.spyOn(gateway.plugins, 'install')],
    ['enable', vi.spyOn(gateway.plugins, 'enable')],
    ['setup', vi.spyOn(gateway.ergates, 'setup')]
  ]
  return {
    order: () =>
      spies
        .flatMap(([name, spy]) => spy.mock.invocationCallOrder.map(at => [at, name] as const))
        .sort(([a], [b]) => a - b)
        .map(([, name]) => name)
  }
}

function stored(id = connection.id): Connection {
  const found = useDeviceStore.getState().connections.find(each => each.id === id)
  if (!found) {
    throw new Error(`no connection ${id}`)
  }
  return found
}

function rowStatus(gateway: FakeGateway): string | undefined {
  return gateway.plugins.rows.find(found => found.name === 'ergates')?.runtime_status
}

type Transition = [UpdateStep, StepStatus]

interface Run {
  outcome: UpdateOutcome
  transitions: Transition[]
  /** The last status each step reported. */
  last: Partial<Record<UpdateStep, StepStatus>>
}

/** Starts a run; `finish` lets every wait elapse and settles it. */
function start(gateway: FakeGateway, overrides: Partial<UpdateDeps> = {}) {
  const transitions: Transition[] = []
  const promise = runUpdate(
    { port: gateway, build: buildRecord(), connectionId: connection.id, target: TARGET, goingBack: false, ...overrides },
    (step, status) => transitions.push([step, status])
  )
  let outcome: UpdateOutcome | null = null
  void promise.then(settled => {
    outcome = settled
  })
  return {
    transitions,
    promise,
    /** The outcome once the run has ended, null while it is still going. */
    get settled(): UpdateOutcome | null {
      return outcome
    },
    async finish(): Promise<Run> {
      await vi.runAllTimersAsync()
      return { outcome: await promise, transitions, last: Object.fromEntries(transitions) }
    }
  }
}

function run(gateway: FakeGateway, overrides?: Partial<UpdateDeps>): Promise<Run> {
  return start(gateway, overrides).finish()
}

/** The check of a plugin whose answering code was loaded from `loaded`, with the files of `commit` on the server. */
function readyAt(loaded: string, commit = TARGET): ServerCheck {
  const install = { kind: 'git install', commit, loaded_commit: loaded, catalog_name: null } as const
  return { kind: 'ready', health: { ...FAKE_PLUGIN_HEALTH, install }, update: null, hermesVersion: null }
}

const networkError = () => new GatewayError('network', 'Could not reach the gateway.')
const signInRequired = () => new GatewayError('unauthorized', 'Sign-in required.', { status: 401 })

beforeEach(() => {
  vi.useFakeTimers()
  useDeviceStore.setState({ connections: [{ ...connection }] })
})

afterEach(async () => {
  // A run that a test left waiting would otherwise be joined by the next test's run.
  await vi.runAllTimersAsync()
  vi.useRealTimers()
})

describe('runUpdate: the update', () => {
  it('turns the plugin off, installs the target over it, starts it and runs the setup', async () => {
    const gateway = runningServer()
    remounting(gateway)
    const calls = watch(gateway)

    const result = await run(gateway)

    expect(result.outcome).toEqual({ kind: 'done', setup: FAKE_SETUP })
    expect(result.transitions).toEqual([
      ['pause', 'active'],
      ['pause', 'done'],
      ['install', 'active'],
      ['install', 'done'],
      ['start', 'active'],
      ['start', 'done'],
      ['setup', 'active'],
      ['setup', 'done']
    ])
    expect(calls.order()).toEqual(['disable', 'install', 'setup'])
    expect(gateway.plugins.disabled).toEqual(['ergates'])
    expect(gateway.plugins.installs).toEqual([{ identifier: PLUGIN_IDENTIFIER, ref: TARGET, enable: true, force: true }])
    expect(gateway.plugins.enabled).toEqual([])
    expect(gateway.plugins.installedCommit).toBe(TARGET)
    expect(rowStatus(gateway)).toBe('enabled')
  })

  it('installs only while the plugin is turned off, so Hermes does not decline the replacement', async () => {
    const gateway = runningServer()
    const install = gateway.plugins.install.bind(gateway.plugins)
    const statusAtInstall: (string | undefined)[] = []
    gateway.plugins.install = req => {
      statusAtInstall.push(rowStatus(gateway))
      return install(req)
    }

    const result = await run(gateway)

    expect(statusAtInstall).toEqual(['disabled'])
    expect(result.outcome).toEqual({ kind: 'restart' })
  })

  it('records the update and the pending setup before it changes anything on the server, and clears both when the setup ran', async () => {
    const gateway = runningServer()
    remounting(gateway)
    const disable = gateway.plugins.disable.bind(gateway.plugins)
    const recorded: Pick<Connection, 'pendingPluginSetup' | 'pluginUpdate'>[] = []
    gateway.plugins.disable = name => {
      recorded.push({ pendingPluginSetup: stored().pendingPluginSetup, pluginUpdate: stored().pluginUpdate })
      return disable(name)
    }

    await run(gateway)

    expect(recorded).toEqual([{ pendingPluginSetup: TARGET, pluginUpdate: { target: TARGET, previous: OLD, previousSchema: 1 } }])
    expect(stored().pendingPluginSetup).toBeUndefined()
    expect(stored().pluginUpdate).toBeUndefined()
  })

  it('learns from which Hermes version a new plugin starts without a restart', async () => {
    const gateway = runningServer('0.21.9')
    remounting(gateway)

    await run(gateway)

    expect(stored().pluginRemountsFrom).toBe('0.21.9')
  })

  it('keeps the version it learned earlier', async () => {
    useDeviceStore.getState().updateConnection(connection.id, { pluginRemountsFrom: '0.21.6' })
    const gateway = runningServer('0.21.9')
    remounting(gateway)

    await run(gateway)

    expect(stored().pluginRemountsFrom).toBe('0.21.6')
  })

  it.each([
    ['a version it cannot place', 'unknown'],
    ['a version with a suffix', '0.21.9rc1'],
    ['a short version', '0.21']
  ])('learns nothing when Hermes reports %s', async (_title, version) => {
    const gateway = runningServer(version)
    remounting(gateway)

    const result = await run(gateway)

    expect(result.outcome).toMatchObject({ kind: 'done' })
    expect(stored().pluginRemountsFrom).toBeUndefined()
  })

  it('learns nothing, and still finishes, when Hermes does not report its version', async () => {
    const gateway = runningServer()
    gateway.setHermesVersion(networkError())
    remounting(gateway)

    const result = await run(gateway)

    expect(result.outcome).toMatchObject({ kind: 'done' })
    expect(stored().pluginRemountsFrom).toBeUndefined()
  })

  // An update starts only from a plugin that answers (the first look must still offer it), so these two cases are going back.
  it('learns nothing when no routes were mounted before going back, since the old code may have been mounted for the first time', async () => {
    const gateway = runningServer()
    remounting(gateway)
    useDeviceStore.getState().updateConnection(connection.id, { pluginUpdate: { target: TARGET, previous: OLD, previousSchema: 1 } })
    let reads = 0
    gateway.ergates.setHealth(() => {
      reads += 1
      return reads === 1 ? { state: 'absent' } : { state: 'answered', health: FAKE_PLUGIN_HEALTH }
    })

    const result = await run(gateway, { target: OLD, goingBack: true })

    expect(result.outcome).toMatchObject({ kind: 'done' })
    expect(stored().pluginRemountsFrom).toBeUndefined()
  })

  it('learns nothing when the target was already the code that answered', async () => {
    const gateway = runningServer()
    // The update put TARGET on the server and asked for a restart that has not happened: OLD still runs.
    gateway.plugins.installedCommit = TARGET
    useDeviceStore.getState().updateConnection(connection.id, { pluginUpdate: { target: TARGET, previous: OLD, previousSchema: 1 } })

    const result = await run(gateway, { target: OLD, goingBack: true })

    expect(result.outcome).toMatchObject({ kind: 'done' })
    expect(stored().pluginRemountsFrom).toBeUndefined()
  })
})

describe('runUpdate: the offer at the first look', () => {
  /** A server whose plugin answers with `install` and `extra`, read for read. */
  function answering(gateway: FakeGateway, install: NonNullable<ErgatesHealth['install']>, extra: Partial<ErgatesHealth> = {}): void {
    gateway.ergates.setHealth({ state: 'answered', health: { ...FAKE_PLUGIN_HEALTH, ...extra, install } })
  }

  function expectNothingChanged(result: Run, gateway: FakeGateway, calls: { order: () => string[] }, before: Connection): void {
    expect(result.outcome).toEqual({ kind: 'stale' })
    expect(calls.order()).toEqual([])
    expect(gateway.plugins.disabled).toEqual([])
    expect(gateway.plugins.installs).toEqual([])
    expect(stored()).toEqual(before)
    expect(result.last).toEqual({ pause: 'pending' })
  }

  it('ends stale, touching nothing, when a second phone put a newer plugin on the server meanwhile', async () => {
    const gateway = runningServer()
    const calls = watch(gateway)
    answering(gateway, { kind: 'git install', commit: 'c'.repeat(40), loaded_commit: 'c'.repeat(40), catalog_name: null }, { plugin_version: '0.4.0', api_level: 2 })
    const before = stored()

    expectNothingChanged(await run(gateway), gateway, calls, before)
  })

  it('ends stale when the server already has this build\'s commit', async () => {
    const gateway = runningServer()
    const calls = watch(gateway)
    answering(gateway, { kind: 'git install', commit: TARGET, loaded_commit: TARGET, catalog_name: null }, { plugin_version: '0.3.0', api_level: 2 })
    const before = stored()

    expectNothingChanged(await run(gateway), gateway, calls, before)
  })

  it.each<[string, NonNullable<ErgatesHealth['install']>]>([
    ['a manual copy', { kind: 'manual copy', commit: null, loaded_commit: null, catalog_name: null }],
    ['an install from the Hermes catalog', { kind: 'git install', commit: OLD, loaded_commit: OLD, catalog_name: 'ergates' }]
  ])('ends stale, touching nothing, when the plugin turns out to be %s', async (_title, install) => {
    const gateway = runningServer()
    const calls = watch(gateway)
    answering(gateway, install)
    const before = stored()

    expectNothingChanged(await run(gateway), gateway, calls, before)
  })

  it('ends stale, touching nothing, while Hermes has to restart for files that changed under the running code', async () => {
    const gateway = runningServer()
    const calls = watch(gateway)
    answering(gateway, { kind: 'git install', commit: 'c'.repeat(40), loaded_commit: OLD, catalog_name: null })
    const before = stored()

    expectNothingChanged(await run(gateway), gateway, calls, before)
  })

  it('ends stale, touching nothing, when the plugin does not answer at the first look', async () => {
    const gateway = runningServer()
    const calls = watch(gateway)
    gateway.ergates.setHealth({ state: 'absent' })
    const before = stored()

    expectNothingChanged(await run(gateway), gateway, calls, before)
  })

  it('records what the server has at the first look as the way back, whatever the caller saw', async () => {
    const gateway = runningServer()
    remounting(gateway)
    const earlier = 'e'.repeat(40)
    gateway.plugins.installedCommit = earlier
    gateway.ergates.loadedCommit = earlier
    const install = gateway.plugins.install.bind(gateway.plugins)
    const recorded: Connection['pluginUpdate'][] = []
    gateway.plugins.install = req => {
      recorded.push(stored().pluginUpdate)
      return install(req)
    }
    gateway.ergates.setHealth(() => ({
      state: 'answered',
      health: { ...FAKE_PLUGIN_HEALTH, store: { plugin_schema_version: 4, min_schema_version: 4, writable: true }, install: { kind: 'git install', commit: gateway.plugins.installedCommit, loaded_commit: gateway.ergates.loadedCommit, catalog_name: null } }
    }))

    const result = await run(gateway)

    expect(result.outcome).toMatchObject({ kind: 'done' })
    expect(recorded).toEqual([{ target: TARGET, previous: earlier, previousSchema: 4 }])
  })

  it('ends stale, touching nothing, when going back while the new version answers', async () => {
    const gateway = runningServer()
    const calls = watch(gateway)
    useDeviceStore.getState().updateConnection(connection.id, { pluginUpdate: { target: TARGET, previous: OLD, previousSchema: 1 } })
    answering(gateway, { kind: 'git install', commit: TARGET, loaded_commit: TARGET, catalog_name: null })
    const before = stored()

    expectNothingChanged(await run(gateway, { target: OLD, goingBack: true }), gateway, calls, before)
  })

  it('remembers a stale end as the last run, so the screens ask the server again', async () => {
    const gateway = runningServer()
    gateway.ergates.setHealth({ state: 'absent' })

    await run(gateway)

    expect(lastUpdateOutcome(connection.id)).toEqual({ kind: 'stale' })
  })
})

describe('runUpdate: Hermes has to restart first', () => {
  it('asks for a restart when the old code still answers, and keeps the update and the pending setup', async () => {
    const gateway = runningServer()
    const calls = watch(gateway)

    const result = await run(gateway)

    expect(result.outcome).toEqual({ kind: 'restart' })
    expect(result.last).toEqual({ pause: 'done', install: 'done', start: 'pending' })
    expect(calls.order()).toEqual(['disable', 'install'])
    expect(gateway.ergates.setupCalls).toBe(0)
    expect(gateway.plugins.installedCommit).toBe(TARGET)
    expect(rowStatus(gateway)).toBe('enabled')
    expect(stored().pendingPluginSetup).toBe(TARGET)
    expect(stored().pluginUpdate).toEqual({ target: TARGET, previous: OLD, previousSchema: 1 })
    expect(stored().pluginRemountsFrom).toBeUndefined()
  })

  it('asks for a restart when a plugin from before it named its loaded commit answers', async () => {
    const gateway = runningServer()
    gateway.ergates.setHealth(() => ({ state: 'answered', health: { ...FAKE_PLUGIN_HEALTH, install: { kind: 'git install', commit: gateway.plugins.installedCommit, catalog_name: null } } }))

    const result = await run(gateway)

    expect(result.outcome).toEqual({ kind: 'restart' })
  })

  it('asks for a restart when Hermes enabled the plugin but does not serve its routes', async () => {
    const gateway = runningServer()
    gateway.ergates.setHealth(afterTheFirstLook({ state: 'not_loaded' }))

    const result = await run(gateway)

    expect(result.outcome).toEqual({ kind: 'restart' })
    expect(result.last).toMatchObject({ install: 'done', start: 'pending' })
    expect(gateway.plugins.enabled).toEqual([])
  })

  it('fails when Hermes never serves the plugin, leaving the new plugin turned on', async () => {
    const gateway = runningServer()
    let reads = 0
    gateway.ergates.setHealth(() => {
      reads += 1
      return reads === 1 ? { state: 'answered', health: FAKE_PLUGIN_HEALTH } : { state: 'absent' }
    })

    const result = await run(gateway)

    expect(result.outcome).toEqual({ kind: 'failed', step: 'start', message: NOT_LOADED })
    expect(result.last).toMatchObject({ install: 'done', start: 'failed' })
    expect(gateway.plugins.enabled).toEqual([])
    expect(gateway.ergates.setupCalls).toBe(0)
    expect(stored().pendingPluginSetup).toBe(TARGET)
  })
})

describe('runUpdate: an update that fails half-way turns the old plugin back on', () => {
  it.each<PluginInstallCode>(['scan_blocked', 'no_git', 'download_failed', 'enable_refused'])('after Hermes refuses with %s', async code => {
    const gateway = runningServer()
    const calls = watch(gateway)
    gateway.plugins.nextInstall(new GatewayError('unknown', 'Hermes words this its own way.', { code, status: 400 }))

    const result = await run(gateway)

    expect(result.outcome).toEqual({ kind: 'manual', failure: code, detail: null })
    expect(result.last).toEqual({ pause: 'done', install: 'failed' })
    expect(calls.order()).toEqual(['disable', 'install', 'enable'])
    expect(rowStatus(gateway)).toBe('enabled')
    expect(gateway.plugins.installedCommit).toBe(OLD)
    expect(gateway.ergates.setupCalls).toBe(0)
  })

  it('after a 400 without a code, with Hermes\'s own text', async () => {
    const gateway = runningServer()
    const calls = watch(gateway)
    const detail = "Plugin 'ergates' was not published: Reinstall declined: dependency install skipped (non-interactive). The installed plugin and active environment are unchanged."
    gateway.plugins.nextInstall(mapPluginInstallError(400, { detail }))

    const result = await run(gateway)

    expect(result.outcome).toEqual({ kind: 'manual', failure: 'refused', detail })
    expect(calls.order()).toEqual(['disable', 'install', 'enable'])
    expect(rowStatus(gateway)).toBe('enabled')
  })

  it('after an answer that is neither a refusal nor a lost request', async () => {
    const gateway = runningServer()
    const calls = watch(gateway)
    gateway.plugins.nextInstall(mapHttpError(403, { detail: 'Not allowed.' }))

    const result = await run(gateway)

    expect(result.outcome).toEqual({ kind: 'failed', step: 'install', message: 'Not allowed.' })
    expect(result.last).toEqual({ pause: 'done', install: 'failed' })
    expect(calls.order()).toEqual(['disable', 'install', 'enable'])
    expect(rowStatus(gateway)).toBe('enabled')
  })

  it('after a lost request once the install time has passed with nothing new on the server', async () => {
    const gateway = runningServer()
    const calls = watch(gateway)
    gateway.plugins.fail('install', networkError())
    const running = start(gateway)

    await vi.advanceTimersByTimeAsync(PLUGIN_INSTALL_TIMEOUT_MS - 1)
    expect(running.settled).toBeNull()
    expect(calls.order()).toEqual(['disable', 'install'])
    await vi.advanceTimersByTimeAsync(1)

    expect(running.settled).toEqual({ kind: 'failed', step: 'install', message: LOST })
    const result = await running.finish()
    expect(result.last).toEqual({ pause: 'done', install: 'failed' })
    expect(calls.order()).toEqual(['disable', 'install', 'enable'])
    expect(rowStatus(gateway)).toBe('enabled')
    expect(gateway.plugins.installs).toHaveLength(1)
    expect(stored().pendingPluginSetup).toBe(TARGET)
  })

  it('after a request that never answers, once the install time has passed', async () => {
    const gateway = runningServer()
    const calls = watch(gateway)
    gateway.plugins.fail('install', 'hang')
    const running = start(gateway)

    await vi.advanceTimersByTimeAsync(PLUGIN_INSTALL_TIMEOUT_MS)

    expect(running.settled).toEqual({ kind: 'failed', step: 'install', message: LOST })
    expect(calls.order()).toEqual(['disable', 'install', 'enable'])
    expect(rowStatus(gateway)).toBe('enabled')
  })

  it('still says what went wrong when turning the plugin back on fails too', async () => {
    const gateway = runningServer()
    gateway.plugins.nextInstall(new GatewayError('unknown', 'Hermes words this its own way.', { code: 'scan_blocked', status: 400 }))
    gateway.plugins.fail('enable', networkError())

    const result = await run(gateway)

    expect(result.outcome).toEqual({ kind: 'manual', failure: 'scan_blocked', detail: null })
    expect(result.last).toEqual({ pause: 'done', install: 'failed' })
    expect(gateway.plugins.enabled).toEqual(['ergates'])
    expect(rowStatus(gateway)).toBe('disabled')
  })

  it('after the turning off itself fails, since the request may have got through', async () => {
    const gateway = runningServer()
    const calls = watch(gateway)
    gateway.plugins.fail('disable', new GatewayError('network', 'Could not reach the gateway.'), 'after')

    const result = await run(gateway)

    expect(result.outcome).toEqual({ kind: 'failed', step: 'pause', message: 'Could not reach the gateway.' })
    expect(result.last).toEqual({ pause: 'failed' })
    expect(calls.order()).toEqual(['disable', 'enable'])
    expect(gateway.plugins.installs).toEqual([])
    expect(rowStatus(gateway)).toBe('enabled')
  })

  it('after an error the app does not know, without its text', async () => {
    const gateway = runningServer()
    const calls = watch(gateway)
    gateway.plugins.disable = () => {
      throw new TypeError('x is not a function')
    }

    const result = await run(gateway)

    expect(result.outcome).toEqual({ kind: 'failed', step: 'pause', message: 'Something went wrong during the update.' })
    expect(calls.order()).toEqual(['enable'])
  })

  it('and asks to sign in again when the install answers 401', async () => {
    const gateway = runningServer()
    const calls = watch(gateway)
    gateway.plugins.nextInstall(signInRequired())

    const result = await run(gateway)

    expect(result.outcome).toEqual({ kind: 'sign_in' })
    expect(result.last).toEqual({ pause: 'done', install: 'failed' })
    expect(calls.order()).toEqual(['disable', 'install', 'enable'])
    expect(rowStatus(gateway)).toBe('enabled')
  })

  it('and asks to sign in again when turning the plugin off answers 401', async () => {
    const gateway = runningServer()
    const calls = watch(gateway)
    gateway.plugins.fail('disable', signInRequired())

    const result = await run(gateway)

    expect(result.outcome).toEqual({ kind: 'sign_in' })
    expect(result.last).toEqual({ pause: 'failed' })
    expect(calls.order()).toEqual(['disable', 'enable'])
  })

  it('and asks to sign in again, touching nothing, when the first look at the plugin answers 401', async () => {
    const gateway = runningServer()
    const calls = watch(gateway)
    gateway.ergates.fail('health', signInRequired())

    const result = await run(gateway)

    expect(result.outcome).toEqual({ kind: 'sign_in' })
    expect(result.last).toEqual({ pause: 'failed' })
    expect(calls.order()).toEqual([])
    expect(rowStatus(gateway)).toBe('enabled')
    expect(stored()).toEqual(connection)
  })

  it('and records nothing when the first look at the plugin fails in a way the app does not know', async () => {
    const gateway = runningServer()
    const calls = watch(gateway)
    gateway.ergates.setHealth(() => {
      throw new TypeError('x is not a function')
    })

    const result = await run(gateway)

    expect(result.outcome).toEqual({ kind: 'failed', step: 'pause', message: 'Something went wrong during the update.' })
    expect(calls.order()).toEqual([])
    expect(stored()).toEqual(connection)
  })

  it('enables the new plugin when the install says it left it off', async () => {
    const gateway = runningServer()
    remounting(gateway)
    const calls = watch(gateway)
    gateway.plugins.nextInstall({ plugin_name: 'ergates', enabled: false })

    const result = await run(gateway)

    expect(result.outcome).toMatchObject({ kind: 'done' })
    expect(calls.order()).toEqual(['disable', 'install', 'enable', 'setup'])
    expect(rowStatus(gateway)).toBe('enabled')
  })

  it('ends in the manual path with Hermes\'s text when it refuses to enable the new plugin, and tries once more to turn it on', async () => {
    const gateway = runningServer()
    const calls = watch(gateway)
    gateway.plugins.nextInstall({ plugin_name: 'ergates', enabled: false })
    gateway.plugins.fail('enable', mapHttpError(400, { detail: 'Not allowed.' }))

    const result = await run(gateway)

    expect(result.outcome).toEqual({ kind: 'manual', failure: 'enable_refused', detail: 'Not allowed.' })
    expect(result.last).toEqual({ pause: 'done', install: 'failed' })
    expect(calls.order()).toEqual(['disable', 'install', 'enable', 'enable'])
    expect(rowStatus(gateway)).toBe('enabled')
  })

  it('leaves the update and the pending setup in place for a later try', async () => {
    const gateway = runningServer()
    gateway.plugins.nextInstall(new GatewayError('unknown', 'Hermes words this its own way.', { code: 'no_git', status: 400 }))

    await run(gateway)

    expect(stored().pendingPluginSetup).toBe(TARGET)
    expect(stored().pluginUpdate).toEqual({ target: TARGET, previous: OLD, previousSchema: 1 })
  })
})

describe('runUpdate: the install request is lost or does not answer', () => {
  it('goes on when the install went through and only its answer was lost', async () => {
    const gateway = runningServer()
    const calls = watch(gateway)
    gateway.plugins.fail('install', networkError(), 'after')

    const result = await run(gateway)

    expect(result.outcome).toEqual({ kind: 'restart' })
    expect(result.last).toEqual({ pause: 'done', install: 'done', start: 'pending' })
    expect(calls.order()).toEqual(['disable', 'install'])
    expect(gateway.plugins.installs).toHaveLength(1)
  })

  it('looks only after a minute for an install that does not answer, then every 5 seconds', async () => {
    const gateway = runningServer()
    gateway.plugins.fail('install', 'hang')
    const health = vi.spyOn(gateway.ergates, 'health')
    const running = start(gateway)

    // The first look at the plugin is the one before it is turned off.
    await vi.advanceTimersByTimeAsync(INSTALL_RACE_AFTER_MS - 1)
    expect(health).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(health).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(4_999)
    expect(health).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(health).toHaveBeenCalledTimes(3)
    expect(running.settled).toBeNull()
    installedOnServer(gateway)
    await running.finish()
  })

  it('goes on as soon as the target is in the record and the plugin is on, and sends no second install', async () => {
    const gateway = runningServer()
    const calls = watch(gateway)
    gateway.plugins.fail('install', 'hang')
    const running = start(gateway)
    await vi.advanceTimersByTimeAsync(66_000)
    installedOnServer(gateway)

    await vi.advanceTimersByTimeAsync(3_999)
    expect(running.settled).toBeNull()
    expect(running.transitions).toEqual([
      ['pause', 'active'],
      ['pause', 'done'],
      ['install', 'active']
    ])
    await vi.advanceTimersByTimeAsync(1)

    expect(running.settled).toMatchObject({ kind: 'done' })
    expect(calls.order()).toEqual(['disable', 'install', 'setup'])
    expect(stored().pendingPluginSetup).toBeUndefined()
  })

  it('keeps waiting while the record names the target but the plugin is still off', async () => {
    const gateway = runningServer()
    gateway.plugins.fail('install', 'hang')
    const running = start(gateway)
    await vi.advanceTimersByTimeAsync(66_000)
    installedOnServer(gateway, 'disabled')

    await vi.advanceTimersByTimeAsync(14_000)
    expect(running.settled).toBeNull()
    gateway.plugins.rows[0].runtime_status = 'enabled'
    await vi.advanceTimersByTimeAsync(5_000)

    expect(running.settled).toMatchObject({ kind: 'done' })
    expect(gateway.plugins.installs).toHaveLength(1)
  })

  it('keeps waiting while the plugin does not answer, since the record cannot be read then', async () => {
    const gateway = runningServer()
    gateway.plugins.fail('install', 'hang')
    gateway.ergates.setHealth(afterTheFirstLook({ state: 'not_loaded' }))
    const running = start(gateway)
    await vi.advanceTimersByTimeAsync(66_000)
    installedOnServer(gateway)

    await vi.advanceTimersByTimeAsync(30_000)

    expect(running.settled).toBeNull()
    await vi.advanceTimersByTimeAsync(PLUGIN_INSTALL_TIMEOUT_MS)
    expect(running.settled).toEqual({ kind: 'failed', step: 'install', message: LOST })
  })

  it('ignores what the abandoned request says when it answers later', async () => {
    const gateway = runningServer()
    gateway.plugins.install = async () => {
      await new Promise(resolve => setTimeout(resolve, 120_000))
      throw new GatewayError('unknown', 'Hermes words this its own way.', { code: 'scan_blocked', status: 400 })
    }
    const running = start(gateway)
    await vi.advanceTimersByTimeAsync(61_000)
    installedOnServer(gateway)

    await vi.advanceTimersByTimeAsync(10_000)
    expect(running.settled).toMatchObject({ kind: 'done' })
    await vi.advanceTimersByTimeAsync(60_000)

    expect(gateway.plugins.enabled).toEqual([])
    expect(stored().pluginUpdate).toBeUndefined()
  })

  it.each([
    ['times out', new GatewayError('timeout', 'The gateway took too long to answer.')],
    ['is answered 502 by a proxy', new GatewayError('unknown', 'The gateway had an internal problem.', { status: 502 })]
  ])('treats an install that %s as lost, not refused', async (_title, error) => {
    const gateway = runningServer()
    gateway.plugins.fail('install', error)
    const running = start(gateway)
    await vi.advanceTimersByTimeAsync(5_000)
    installedOnServer(gateway)

    const result = await running.finish()

    expect(result.outcome).toMatchObject({ kind: 'done' })
    expect(gateway.plugins.installs).toHaveLength(1)
    expect(gateway.plugins.enabled).toEqual([])
  })
})

describe('runUpdate: going back', () => {
  const FAILED_UPDATE = { target: TARGET, previous: OLD, previousSchema: 1 }

  /** A server whose new plugin did not start: the update left its record, flag and pending setup behind. */
  function serverAfterFailedUpdate(): FakeGateway {
    const gateway = runningServer()
    gateway.plugins.installedCommit = TARGET
    gateway.ergates.setHealth({ state: 'not_loaded' })
    markPendingSetup(connection.id, TARGET)
    useDeviceStore.getState().updateConnection(connection.id, { pluginUpdate: FAILED_UPDATE })
    return gateway
  }

  it('installs the previous commit the same way, records that it is back, and marks no pending setup of its own', async () => {
    const gateway = serverAfterFailedUpdate()
    const calls = watch(gateway)
    const disable = gateway.plugins.disable.bind(gateway.plugins)
    const recorded: Pick<Connection, 'pendingPluginSetup' | 'pluginUpdate' | 'pluginWentBack'>[] = []
    gateway.plugins.disable = name => {
      recorded.push({ pendingPluginSetup: stored().pendingPluginSetup, pluginUpdate: stored().pluginUpdate, pluginWentBack: stored().pluginWentBack })
      return disable(name)
    }
    gateway.ergates.setHealth(() => ({ state: 'answered', health: { ...FAKE_PLUGIN_HEALTH, install: { kind: 'git install', commit: OLD, loaded_commit: OLD, catalog_name: null } } }))

    const result = await run(gateway, { target: OLD, goingBack: true })

    // Before the install is confirmed nothing changes on the phone: the update stays, and the previous version was set up when it was first installed.
    expect(recorded).toEqual([{ pendingPluginSetup: TARGET, pluginUpdate: FAILED_UPDATE, pluginWentBack: undefined }])
    expect(result.outcome).toEqual({ kind: 'done', setup: FAKE_SETUP })
    expect(gateway.plugins.installs).toEqual([{ identifier: PLUGIN_IDENTIFIER, ref: OLD, enable: true, force: true }])
    expect(calls.order()).toEqual(['disable', 'install', 'setup'])
    expect(stored().pluginUpdate).toBeUndefined()
    expect(stored().pendingPluginSetup).toBeUndefined()
    expect(stored().pluginWentBack).toEqual({ to: OLD, from: TARGET })
  })

  it('ends the update once the install is confirmed, so nothing waits for the failed commit when Hermes has to restart', async () => {
    const gateway = serverAfterFailedUpdate()
    // The new version did not start; once the old files are back, the package of the new one still answers until Hermes restarts.
    gateway.ergates.setHealth(notLoadedThen({ state: 'answered', health: { ...FAKE_PLUGIN_HEALTH, install: { kind: 'git install', commit: OLD, loaded_commit: TARGET, catalog_name: null } } }))

    const result = await run(gateway, { target: OLD, goingBack: true })

    expect(result.outcome).toEqual({ kind: 'restart' })
    expect(gateway.ergates.setupCalls).toBe(0)
    expect(stored().pluginUpdate).toBeUndefined()
    expect(stored().pendingPluginSetup).toBeUndefined()
    expect(stored().pluginWentBack).toEqual({ to: OLD, from: TARGET })
  })

  it('confirms the install it found on the server when the answer to the request was lost', async () => {
    const gateway = serverAfterFailedUpdate()
    gateway.plugins.fail('install', networkError(), 'after')
    gateway.ergates.setHealth(notLoadedThen({ state: 'answered', health: { ...FAKE_PLUGIN_HEALTH, install: { kind: 'git install', commit: OLD, loaded_commit: TARGET, catalog_name: null } } }))

    const result = await run(gateway, { target: OLD, goingBack: true })

    expect(result.outcome).toEqual({ kind: 'restart' })
    expect(stored().pluginUpdate).toBeUndefined()
    expect(stored().pluginWentBack).toEqual({ to: OLD, from: TARGET })
  })

  it('keeps a pending setup that is not the failed update\'s', async () => {
    const gateway = serverAfterFailedUpdate()
    const other = 'e'.repeat(40)
    markPendingSetup(connection.id, other)
    gateway.ergates.setHealth(notLoadedThen({ state: 'answered', health: { ...FAKE_PLUGIN_HEALTH, install: { kind: 'git install', commit: OLD, loaded_commit: TARGET, catalog_name: null } } }))

    await run(gateway, { target: OLD, goingBack: true })

    expect(stored().pendingPluginSetup).toBe(other)
  })

  it('turns the plugin back on when the install is refused, as an update does, and leaves the update in place', async () => {
    const gateway = serverAfterFailedUpdate()
    const calls = watch(gateway)
    gateway.plugins.nextInstall(new GatewayError('unknown', 'Hermes words this its own way.', { code: 'download_failed', status: 400 }))

    const result = await run(gateway, { target: OLD, goingBack: true })

    expect(result.outcome).toEqual({ kind: 'manual', failure: 'download_failed', detail: null })
    expect(calls.order()).toEqual(['disable', 'install', 'enable'])
    expect(stored().pluginUpdate).toEqual(FAILED_UPDATE)
    expect(stored().pendingPluginSetup).toBe(TARGET)
    expect(stored().pluginWentBack).toBeUndefined()
  })
})

describe('runUpdate: what is left of a going back', () => {
  const WENT_BACK = { to: OLD, from: TARGET }

  it('is forgotten when a new update starts', async () => {
    const gateway = runningServer()
    useDeviceStore.getState().updateConnection(connection.id, { pluginWentBack: WENT_BACK })
    const disable = gateway.plugins.disable.bind(gateway.plugins)
    const atDisable: Connection['pluginWentBack'][] = []
    gateway.plugins.disable = name => {
      atDisable.push(stored().pluginWentBack)
      return disable(name)
    }

    await run(gateway)

    expect(atDisable).toEqual([undefined])
    expect(stored().pluginWentBack).toBeUndefined()
  })

  it('stays when the update ends stale, since nothing changed', async () => {
    const gateway = runningServer()
    gateway.ergates.setHealth({ state: 'absent' })
    useDeviceStore.getState().updateConnection(connection.id, { pluginWentBack: WENT_BACK })

    const result = await run(gateway)

    expect(result.outcome).toEqual({ kind: 'stale' })
    expect(stored().pluginWentBack).toEqual(WENT_BACK)
  })

  it('stays when the update cannot even look at the server', async () => {
    const gateway = runningServer()
    gateway.ergates.setHealth(signInRequired())
    useDeviceStore.getState().updateConnection(connection.id, { pluginWentBack: WENT_BACK })

    const result = await run(gateway)

    expect(result.outcome).toEqual({ kind: 'sign_in' })
    expect(stored().pluginWentBack).toEqual(WENT_BACK)
  })
})

describe('runUpdate: a plugin whose store cannot open', () => {
  const unavailable = () => mapErgatesError(503, { error: { code: 'store_unavailable', message: 'the Ergates control store is unavailable' } })

  it('asks for a restart when the plugin still answers 503 after the install, as code that cannot open its store does until Hermes restarts', async () => {
    const gateway = runningServer()
    const calls = watch(gateway)
    gateway.ergates.setHealth(afterTheFirstLook(unavailable))

    const result = await run(gateway)

    expect(result.outcome).toEqual({ kind: 'restart' })
    expect(result.last).toEqual({ pause: 'done', install: 'done', start: 'pending' })
    expect(calls.order()).toEqual(['disable', 'install'])
    expect(stored().pendingPluginSetup).toBe(TARGET)
  })

  it('does the same going back from a plugin the check called unavailable, and ends the update it undid', async () => {
    const gateway = runningServer()
    const failed = { target: TARGET, previous: OLD, previousSchema: 1 }
    useDeviceStore.getState().updateConnection(connection.id, { pluginUpdate: failed })
    gateway.ergates.setHealth(unavailable)

    const result = await run(gateway, { target: OLD, goingBack: true })

    expect(result.outcome).toEqual({ kind: 'restart' })
    expect(gateway.plugins.installs).toEqual([{ identifier: PLUGIN_IDENTIFIER, ref: OLD, enable: true, force: true }])
    expect(stored().pluginUpdate).toBeUndefined()
    expect(stored().pendingPluginSetup).toBeUndefined()
    expect(stored().pluginWentBack).toEqual({ to: OLD, from: TARGET })
  })

  it('still fails the start for any other error from the plugin', async () => {
    const gateway = runningServer()
    gateway.ergates.setHealth(afterTheFirstLook(() => mapErgatesError(500, { error: { code: 'internal', message: 'The request could not be completed.' } })))

    const result = await run(gateway)

    expect(result.outcome).toEqual({ kind: 'failed', step: 'start', message: 'The request could not be completed.' })
  })
})

describe('runUpdate: what it installs', () => {
  it.each<[string, Partial<UpdateDeps>]>([
    ['a target that is not a full commit', { target: 'main' }],
    ['a commit that is not this build\'s', { target: 'c'.repeat(40) }],
    ['a going back to something that is not a full commit', { target: 'v0.2.0', goingBack: true }]
  ])('leaves %s to the guide, touching nothing', async (_title, overrides) => {
    const gateway = runningServer()
    const calls = watch(gateway)

    const result = await run(gateway, overrides)

    expect(result.outcome).toEqual({ kind: 'manual', failure: 'refused', detail: null })
    expect(result.transitions).toEqual([])
    expect(calls.order()).toEqual([])
    expect(gateway.ergates.calls).toEqual([])
    expect(stored()).toEqual(connection)
  })

  it('leaves a build without a commit to the guide', async () => {
    const gateway = runningServer()

    const result = await run(gateway, { build: buildRecord(null) })

    expect(result.outcome).toEqual({ kind: 'manual', failure: 'refused', detail: null })
    expect(gateway.plugins.disabled).toEqual([])
  })

  it('goes back to the commit the update recorded, although it is not the build\'s', async () => {
    const gateway = runningServer()
    remounting(gateway)
    const other = 'c'.repeat(40)
    useDeviceStore.getState().updateConnection(connection.id, { pluginUpdate: { target: TARGET, previous: other, previousSchema: 1 } })

    const result = await run(gateway, { target: other, goingBack: true })

    expect(result.outcome).toMatchObject({ kind: 'done' })
    expect(gateway.plugins.installs).toEqual([{ identifier: PLUGIN_IDENTIFIER, ref: other, enable: true, force: true }])
  })

  it.each<[string, Connection['pluginUpdate']]>([
    ['another commit than the update recorded', { target: TARGET, previous: 'd'.repeat(40), previousSchema: 1 }],
    ['when no update was recorded', undefined]
  ])('refuses to go back to %s, touching nothing', async (_title, recorded) => {
    const gateway = runningServer()
    const calls = watch(gateway)
    useDeviceStore.getState().updateConnection(connection.id, { pluginUpdate: recorded })
    const before = stored()

    const result = await run(gateway, { target: 'c'.repeat(40), goingBack: true })

    expect(result.outcome).toEqual({ kind: 'manual', failure: 'refused', detail: null })
    expect(result.transitions).toEqual([])
    expect(calls.order()).toEqual([])
    expect(gateway.ergates.calls).toEqual([])
    expect(stored()).toEqual(before)
  })
})

describe('runUpdate: sign-in and the steps after the install', () => {
  it('asks to sign in again when the start answers 401, without turning anything on', async () => {
    const gateway = runningServer()
    const calls = watch(gateway)
    let reads = 0
    gateway.ergates.setHealth(() => {
      reads += 1
      return reads === 1 ? { state: 'answered', health: FAKE_PLUGIN_HEALTH } : signInRequired()
    })

    const result = await run(gateway)

    expect(result.outcome).toEqual({ kind: 'sign_in' })
    expect(result.last).toMatchObject({ install: 'done', start: 'failed' })
    expect(calls.order()).toEqual(['disable', 'install'])
  })

  it('fails the setup step and keeps the update and the pending setup when the setup does not run', async () => {
    const gateway = runningServer()
    remounting(gateway)
    const calls = watch(gateway)
    gateway.ergates.fail('setup', new GatewayError('unknown', 'The request could not be completed.', { status: 500 }))

    const result = await run(gateway)

    expect(result.outcome).toEqual({ kind: 'failed', step: 'setup', message: 'The request could not be completed.' })
    expect(result.last).toMatchObject({ start: 'done', setup: 'failed' })
    expect(calls.order()).toEqual(['disable', 'install', 'setup'])
    expect(stored().pendingPluginSetup).toBe(TARGET)
    expect(stored().pluginUpdate).toEqual({ target: TARGET, previous: OLD, previousSchema: 1 })
  })

  it('finishes the setup after the sign-in when the setup answered 401', async () => {
    const gateway = runningServer()
    remounting(gateway)
    gateway.ergates.fail('setup', signInRequired())

    const result = await run(gateway)

    expect(result.outcome).toEqual({ kind: 'sign_in' })
    const report = await finishPendingSetup(gateway, stored(), readyAt(TARGET))
    expect(report).toEqual({ kind: 'done', report: FAKE_SETUP })
    expect(stored().pendingPluginSetup).toBeUndefined()
    expect(stored().pluginUpdate).toBeUndefined()
  })
})

describe('the pending setup after an update', () => {
  it('does not run the setup on the old code, and runs it once Hermes restarted', async () => {
    const gateway = runningServer()
    await run(gateway)
    expect(stored().pendingPluginSetup).toBe(TARGET)

    const onOldCode = await finishPendingSetup(gateway, stored(), readyAt(OLD))
    expect(onOldCode).toEqual({ kind: 'waiting' })
    expect(gateway.ergates.setupCalls).toBe(0)

    const afterRestart = await finishPendingSetup(gateway, stored(), readyAt(TARGET))

    expect(afterRestart).toEqual({ kind: 'done', report: FAKE_SETUP })
    expect(gateway.ergates.setupCalls).toBe(1)
    expect(stored().pendingPluginSetup).toBeUndefined()
    expect(stored().pluginUpdate).toBeUndefined()
  })
})

describe('a setup after an update that waits for Hermes to restart', () => {
  it('does not run the plugin\'s setup on the old code, and leaves it to the new code after the restart', async () => {
    const gateway = runningServer()
    await run(gateway)
    const update = { target: TARGET, previous: OLD, previousSchema: 1 }

    const retry = await runSetup({ port: gateway, build: buildRecord(), connectionId: connection.id }, () => undefined)

    expect(retry).toEqual({ kind: 'restart' })
    expect(gateway.ergates.setupCalls).toBe(0)
    expect(stored().pendingPluginSetup).toBe(TARGET)
    expect(stored().pluginUpdate).toEqual(update)

    gateway.ergates.loadedCommit = TARGET
    const afterRestart = await finishPendingSetup(gateway, stored(), readyAt(TARGET))

    expect(afterRestart).toEqual({ kind: 'done', report: FAKE_SETUP })
    expect(gateway.ergates.setupCalls).toBe(1)
    expect(stored().pendingPluginSetup).toBeUndefined()
    expect(stored().pluginUpdate).toBeUndefined()
  })
})

describe('a setup after going back waits for Hermes to restart', () => {
  it('points the pending setup at the commit that loads after the restart, so the setup runs then', async () => {
    const gateway = runningServer()
    const failed = { target: TARGET, previous: OLD, previousSchema: 1 }
    // The update put TARGET on the server and its package was imported, but its routes did not start: going back installs OLD.
    gateway.plugins.installedCommit = TARGET
    gateway.ergates.loadedCommit = TARGET
    const served = gateway.ergates.health.bind(gateway.ergates)
    let reads = 0
    gateway.ergates.health = () => {
      reads += 1
      return reads === 1 ? Promise.resolve({ state: 'not_loaded' }) : served()
    }
    useDeviceStore.getState().updateConnection(connection.id, { pluginUpdate: failed })

    const back = await run(gateway, { target: OLD, goingBack: true })
    expect(back.outcome).toEqual({ kind: 'restart' })
    // Going back leaves nothing pending: the previous version was set up when it was first installed.
    expect(stored().pendingPluginSetup).toBeUndefined()
    expect(stored().pluginUpdate).toBeUndefined()

    const setup = await runSetup({ port: gateway, build: buildRecord(), connectionId: connection.id }, () => undefined)

    expect(setup).toEqual({ kind: 'restart' })
    expect(gateway.ergates.setupCalls).toBe(0)
    expect(stored().pendingPluginSetup).toBe(OLD)

    gateway.ergates.loadedCommit = OLD
    const afterRestart = await finishPendingSetup(gateway, stored(), readyAt(OLD, OLD))

    expect(afterRestart).toEqual({ kind: 'done', report: FAKE_SETUP })
    expect(gateway.ergates.setupCalls).toBe(1)
    expect(stored().pendingPluginSetup).toBeUndefined()
  })
})

describe('runUpdate: the connection changes while the plugin\'s setup runs', () => {
  const NEWER = 'e'.repeat(40)
  const next = { target: NEWER, previous: TARGET, previousSchema: 2 }

  it('keeps an update that was started meanwhile, with its pending setup', async () => {
    const gateway = runningServer()
    remounting(gateway)
    gateway.ergates.setup = async () => {
      markPendingSetup(connection.id, NEWER)
      useDeviceStore.getState().updateConnection(connection.id, { pluginUpdate: next })
      return FAKE_SETUP
    }

    const result = await run(gateway)

    expect(result.outcome).toMatchObject({ kind: 'done' })
    expect(stored().pendingPluginSetup).toBe(NEWER)
    expect(stored().pluginUpdate).toEqual(next)
  })

  it('clears the pending setup it ran for and keeps an update that changed', async () => {
    const gateway = runningServer()
    remounting(gateway)
    gateway.ergates.setup = async () => {
      useDeviceStore.getState().updateConnection(connection.id, { pluginUpdate: next })
      return FAKE_SETUP
    }

    await run(gateway)

    expect(stored().pendingPluginSetup).toBeUndefined()
    expect(stored().pluginUpdate).toEqual(next)
  })
})

describe('runUpdate: one run per connection', () => {
  it('joins an update that is going instead of starting another', async () => {
    const gateway = runningServer()
    gateway.plugins.fail('install', networkError())
    const first = start(gateway)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(first.transitions).toEqual([
      ['pause', 'active'],
      ['pause', 'done'],
      ['install', 'active']
    ])

    const joined: Transition[] = []
    const second = runUpdate({ port: gateway, build: buildRecord(), connectionId: connection.id, target: TARGET, goingBack: false }, (step, status) => joined.push([step, status]))

    // The joiner is told where the run is at once.
    expect(joined).toEqual([
      ['pause', 'done'],
      ['install', 'active']
    ])
    installedOnServer(gateway)
    const result = await first.finish()

    expect(result.outcome).toMatchObject({ kind: 'done' })
    await expect(second).resolves.toEqual(result.outcome)
    expect(joined).toEqual([
      ['pause', 'done'],
      ['install', 'active'],
      ['install', 'done'],
      ['start', 'active'],
      ['start', 'done'],
      ['setup', 'active'],
      ['setup', 'done']
    ])
    expect(gateway.plugins.disabled).toHaveLength(1)
    expect(gateway.plugins.installs).toHaveLength(1)
  })

  it('refuses a setup while going back is running, and says so', async () => {
    const gateway = runningServer()
    useDeviceStore.getState().updateConnection(connection.id, { pluginUpdate: { target: TARGET, previous: OLD, previousSchema: 1 } })
    gateway.plugins.fail('install', networkError())
    const going = start(gateway, { target: OLD, goingBack: true })
    await vi.advanceTimersByTimeAsync(1_000)
    const health = vi.spyOn(gateway.ergates, 'health')

    const refused = await runSetup({ port: gateway, build: buildRecord(), connectionId: connection.id }, () => undefined)

    expect(refused).toEqual({ kind: 'failed', step: 'install', message: 'Going back is running. Try again when it is done.' })
    expect(health).not.toHaveBeenCalled()
    gateway.plugins.installedCommit = OLD
    gateway.plugins.rows[0].runtime_status = 'enabled'
    await going.finish()
  })

  it('refuses a call for another target while an update is going, instead of giving it the outcome of the other', async () => {
    const gateway = runningServer()
    gateway.plugins.fail('install', networkError())
    const first = start(gateway)
    await vi.advanceTimersByTimeAsync(2_000)
    const steps: Transition[] = []

    const refused = await runUpdate(
      { port: gateway, build: buildRecord(), connectionId: connection.id, target: 'c'.repeat(40), goingBack: true },
      (step, status) => steps.push([step, status])
    )

    expect(refused).toEqual({ kind: 'failed', step: 'pause', message: 'An update is running. Try again when it is done.' })
    expect(steps).toEqual([])
    expect(gateway.plugins.installs).toHaveLength(1)
    installedOnServer(gateway)
    const result = await first.finish()
    expect(result.outcome).toMatchObject({ kind: 'done' })
    expect(stored().pluginUpdate).toBeUndefined()
  })

  it('refuses an update for the build while going back is running', async () => {
    const gateway = runningServer()
    useDeviceStore.getState().updateConnection(connection.id, { pluginUpdate: { target: TARGET, previous: OLD, previousSchema: 1 } })
    gateway.plugins.fail('install', networkError())
    const going = start(gateway, { target: OLD, goingBack: true })
    await vi.advanceTimersByTimeAsync(2_000)

    const refused = await runUpdate({ port: gateway, build: buildRecord(), connectionId: connection.id, target: TARGET, goingBack: false }, () => undefined)

    expect(refused).toEqual({ kind: 'failed', step: 'pause', message: 'Going back is running. Try again when it is done.' })
    expect(gateway.plugins.installs).toHaveLength(1)
    gateway.plugins.installedCommit = OLD
    gateway.plugins.rows[0].runtime_status = 'enabled'
    await going.finish()
  })

  it('still joins a call for the same target', async () => {
    const gateway = runningServer()
    gateway.plugins.fail('install', networkError())
    const first = start(gateway)
    await vi.advanceTimersByTimeAsync(2_000)

    const second = runUpdate({ port: gateway, build: buildRecord(), connectionId: connection.id, target: TARGET, goingBack: false }, () => undefined)

    installedOnServer(gateway)
    const result = await first.finish()
    await expect(second).resolves.toEqual(result.outcome)
    expect(gateway.plugins.installs).toHaveLength(1)
  })

  it('refuses an update while a setup is going, and the setup goes on', async () => {
    const gateway = emptyServer()
    gateway.plugins.fail('install', networkError())
    const setup = runSetup({ port: gateway, build: buildRecord(), connectionId: connection.id }, () => undefined)
    await vi.advanceTimersByTimeAsync(1_000)
    const before = gateway.ergates.calls.length

    const refused = await runUpdate({ port: gateway, build: buildRecord(), connectionId: connection.id, target: TARGET, goingBack: false }, () => undefined)

    expect(refused).toEqual({ kind: 'failed', step: 'pause', message: 'Setting up this server is running. Try again when it is done.' })
    expect(gateway.plugins.disabled).toEqual([])
    expect(gateway.ergates.calls).toHaveLength(before)
    expect(stored().pluginUpdate).toBeUndefined()
    gateway.plugins.rows = [{ name: 'ergates', version: '0.3.0', runtime_status: 'enabled' }]
    await vi.runAllTimersAsync()
    await expect(setup).resolves.toMatchObject({ kind: 'done' })
  })

  it('refuses a setup while an update is going, and the update goes on', async () => {
    const gateway = runningServer()
    gateway.plugins.fail('install', networkError())
    const update = start(gateway)
    await vi.advanceTimersByTimeAsync(1_000)
    const health = vi.spyOn(gateway.ergates, 'health')

    const refused = await runSetup({ port: gateway, build: buildRecord(), connectionId: connection.id }, () => undefined)

    expect(refused).toEqual({ kind: 'failed', step: 'install', message: 'The plugin is being updated. Try again when it is done.' })
    expect(health).not.toHaveBeenCalled()
    installedOnServer(gateway)
    const result = await update.finish()
    expect(result.outcome).toMatchObject({ kind: 'done' })
    expect(gateway.ergates.setupCalls).toBe(1)
  })

  it('starts a setup, and an update, once the other kind of run has ended', async () => {
    const gateway = runningServer()
    remounting(gateway)
    await run(gateway)

    const setup = await runSetup({ port: gateway, build: buildRecord(), connectionId: connection.id }, () => undefined)
    // Someone put the old plugin back by hand, so the server needs the update again.
    gateway.plugins.installedCommit = OLD
    gateway.ergates.loadedCommit = OLD
    const update = await run(gateway)

    expect(setup).toMatchObject({ kind: 'done' })
    expect(update.outcome).toMatchObject({ kind: 'done' })
  })

  it('says a run is going while an update runs, for its connection only, and leaves the pending setup to it', async () => {
    useDeviceStore.setState({ connections: [{ ...connection }, { ...connection, id: 'c-2' }] })
    const gateway = runningServer()
    gateway.plugins.fail('install', networkError())
    const running = start(gateway)
    await vi.advanceTimersByTimeAsync(1_000)

    expect(isSetupRunning(connection.id)).toBe(true)
    expect(isSetupRunning('c-2')).toBe(false)
    expect(runningKind(connection.id)).toBe('update')
    expect(runningKind('c-2')).toBeNull()
    await expect(finishPendingSetup(gateway, stored(), readyAt(TARGET))).resolves.toEqual({ kind: 'waiting' })
    expect(gateway.ergates.setupCalls).toBe(0)

    installedOnServer(gateway)
    await running.finish()
    expect(isSetupRunning(connection.id)).toBe(false)
    expect(runningKind(connection.id)).toBeNull()
    expect(gateway.ergates.setupCalls).toBe(1)
  })

  it('does not join the update of another connection', async () => {
    useDeviceStore.setState({ connections: [{ ...connection }, { ...connection, id: 'c-2' }] })
    const gateway = runningServer()
    gateway.plugins.fail('install', networkError())
    const first = start(gateway)
    await vi.advanceTimersByTimeAsync(1_000)
    const other = runningServer()
    remounting(other)

    const second = await runUpdate({ port: other, build: buildRecord(), connectionId: 'c-2', target: TARGET, goingBack: false }, () => undefined)

    expect(second).toMatchObject({ kind: 'done' })
    expect(first.settled).toBeNull()
    installedOnServer(gateway)
    await first.finish()
  })
})

describe('lastUpdateOutcome: what the Finish screen shows of an update that ended', () => {
  const OTHER = 'c-9'

  it('is null for a connection that has not run an update', () => {
    expect(lastUpdateOutcome(OTHER)).toBeNull()
  })

  it.each<[string, (gateway: FakeGateway) => void, UpdateOutcome]>([
    ['a restart', () => undefined, { kind: 'restart' }],
    ['a refusal', gateway => gateway.plugins.nextInstall(new GatewayError('unknown', 'Hermes words this its own way.', { code: 'no_git', status: 400 })), { kind: 'manual', failure: 'no_git', detail: null }],
    ['a failed step', gateway => gateway.plugins.nextInstall(mapHttpError(403, { detail: 'Not allowed.' })), { kind: 'failed', step: 'install', message: 'Not allowed.' }],
    ['a sign-in', gateway => gateway.plugins.nextInstall(signInRequired()), { kind: 'sign_in' }]
  ])('holds the outcome of %s', async (_title, scripted, expected) => {
    const gateway = runningServer()
    scripted(gateway)

    await run(gateway)

    expect(lastUpdateOutcome(connection.id)).toEqual(expected)
  })

  it('holds an update that finished', async () => {
    const gateway = runningServer()
    remounting(gateway)

    await run(gateway)

    expect(lastUpdateOutcome(connection.id)).toEqual({ kind: 'done', setup: FAKE_SETUP })
  })

  it('is there when the run settles, before anything that waited on it continues', async () => {
    const gateway = runningServer()
    let seen: unknown = 'not read'
    const running = start(gateway)
    void running.promise.then(() => {
      seen = lastUpdateOutcome(connection.id)
    })

    await running.finish()

    expect(seen).toEqual({ kind: 'restart' })
  })

  it('is cleared when the next run starts', async () => {
    await run(runningServer())
    expect(lastUpdateOutcome(connection.id)).toEqual({ kind: 'restart' })
    const gateway = runningServer()
    remounting(gateway)

    const running = start(gateway)
    expect(lastUpdateOutcome(connection.id)).toBeNull()
    await running.finish()

    expect(lastUpdateOutcome(connection.id)).toMatchObject({ kind: 'done' })
  })

  it('is kept per connection', async () => {
    await run(runningServer())

    expect(lastUpdateOutcome(OTHER)).toBeNull()
  })

  it('stays when a call is refused or only joins the run that is going', async () => {
    await run(runningServer())
    const gateway = emptyServer()
    gateway.plugins.fail('install', networkError())
    const setup = runSetup({ port: gateway, build: buildRecord(), connectionId: connection.id }, () => undefined)
    await vi.advanceTimersByTimeAsync(1_000)

    await runUpdate({ port: gateway, build: buildRecord(), connectionId: connection.id, target: TARGET, goingBack: false }, () => undefined)

    expect(lastUpdateOutcome(connection.id)).toEqual({ kind: 'restart' })
    gateway.plugins.rows = [{ name: 'ergates', version: '0.3.0', runtime_status: 'enabled' }]
    await vi.runAllTimersAsync()
    await setup
  })
})

describe('joinUpdate: joining a run that is going, and never starting one', () => {
  it('joins the update that is going, is told where it is at once, and settles with its outcome', async () => {
    const gateway = runningServer()
    gateway.plugins.fail('install', networkError())
    const first = start(gateway)
    await vi.advanceTimersByTimeAsync(2_000)

    const joined: Transition[] = []
    const second = joinUpdate(connection.id, false, (step, status) => joined.push([step, status]))

    expect(joined).toEqual([
      ['pause', 'done'],
      ['install', 'active']
    ])
    installedOnServer(gateway)
    const result = await first.finish()
    await expect(second).resolves.toEqual(result.outcome)
    expect(joined.at(-1)).toEqual(['setup', 'done'])
    expect(gateway.plugins.installs).toHaveLength(1)
  })

  it('answers null and touches nothing when no run is going', () => {
    const gateway = runningServer()
    const calls = watch(gateway)
    const reported: Transition[] = []

    expect(joinUpdate(connection.id, false, (step, status) => reported.push([step, status]))).toBeNull()

    expect(runningKind(connection.id)).toBeNull()
    expect(calls.order()).toEqual([])
    expect(reported).toEqual([])
  })

  it('answers null for a run that has already ended, so a screen that comes too late starts nothing', async () => {
    const gateway = runningServer()
    remounting(gateway)
    await run(gateway)
    const calls = watch(gateway)

    expect(joinUpdate(connection.id, false, () => undefined)).toBeNull()

    expect(runningKind(connection.id)).toBeNull()
    expect(calls.order()).toEqual([])
  })

  it('joins an update only when asked for an update, and a going back only when asked for one', async () => {
    const gateway = runningServer()
    useDeviceStore.getState().updateConnection(connection.id, { pluginUpdate: { target: TARGET, previous: OLD, previousSchema: 1 } })
    gateway.plugins.fail('install', networkError())
    const going = start(gateway, { target: OLD, goingBack: true })
    await vi.advanceTimersByTimeAsync(2_000)

    expect(joinUpdate(connection.id, false, () => undefined)).toBeNull()
    const joined = joinUpdate(connection.id, true, () => undefined)
    expect(joined).not.toBeNull()

    gateway.plugins.installedCommit = OLD
    gateway.plugins.rows[0].runtime_status = 'enabled'
    const result = await going.finish()
    await expect(joined).resolves.toEqual(result.outcome)
  })

  it('does not join the update of another connection, or a setup that is going', async () => {
    const gateway = emptyServer()
    gateway.plugins.fail('install', networkError())
    const setup = runSetup({ port: gateway, build: buildRecord(), connectionId: connection.id }, () => undefined)
    await vi.advanceTimersByTimeAsync(1_000)

    expect(joinUpdate(connection.id, false, () => undefined)).toBeNull()
    expect(joinUpdate('c-9', false, () => undefined)).toBeNull()
    gateway.plugins.rows = [{ name: 'ergates', version: '0.3.0', runtime_status: 'enabled' }]
    await vi.runAllTimersAsync()
    await setup
  })
})

describe('lastUpdateRun: whether the last run was a going back', () => {
  const FAILED_UPDATE = { target: TARGET, previous: OLD, previousSchema: 1 }

  it('is null for a connection that has not run an update', () => {
    expect(lastUpdateRun('c-9')).toBeNull()
  })

  it('holds the outcome of an update, and says it was not a going back', async () => {
    await run(runningServer())

    expect(lastUpdateRun(connection.id)).toEqual({ outcome: { kind: 'restart' }, goingBack: false })
    expect(lastUpdateRun(connection.id)?.outcome).toBe(lastUpdateOutcome(connection.id))
  })

  it('says the last run was a going back', async () => {
    const gateway = runningServer()
    useDeviceStore.getState().updateConnection(connection.id, { pluginUpdate: FAILED_UPDATE })

    await run(gateway, { target: OLD, goingBack: true })

    expect(lastUpdateRun(connection.id)).toMatchObject({ goingBack: true })
  })

  it('says a run the app refuses to start was not a going back, or was one when it was asked for one', async () => {
    await run(runningServer(), { target: 'v0.2.0', goingBack: true })

    expect(lastUpdateRun(connection.id)).toEqual({ outcome: { kind: 'manual', failure: 'refused', detail: null }, goingBack: true })
  })
})

describe('restartWatchOf: the restart signs the Finish page keeps beyond one mount', () => {
  it('has seen nothing for a connection that never folded a poll', () => {
    expect(restartWatchOf('c-8')).toBe(NOT_WATCHED)
  })

  it('folds each poll in and keeps what the polls showed', () => {
    watchUpdateRestart('c-7', { kind: 'restart_needed', health: FAKE_PLUGIN_HEALTH, hermesVersion: null }, false)
    expect(restartWatchOf('c-7')).toEqual({ oldCodeAnswered: true, seen: false })

    const after = watchUpdateRestart('c-7', { kind: 'not_loaded', hermesVersion: null }, false)

    expect(after).toEqual({ oldCodeAnswered: true, seen: true })
    expect(restartWatchOf('c-7')).toBe(after)
  })

  it('is kept per connection', () => {
    watchUpdateRestart('c-6', null, true)

    expect(restartWatchOf('c-5')).toBe(NOT_WATCHED)
  })

  it('starts again when a new update run starts', async () => {
    watchUpdateRestart(connection.id, null, true)
    expect(restartWatchOf(connection.id).seen).toBe(true)

    const running = start(runningServer())
    expect(restartWatchOf(connection.id)).toBe(NOT_WATCHED)
    await running.finish()
  })

  it('stays when a call only joins the run that is going', async () => {
    const gateway = runningServer()
    gateway.plugins.fail('install', networkError())
    const first = start(gateway)
    await vi.advanceTimersByTimeAsync(2_000)
    watchUpdateRestart(connection.id, null, true)

    void joinUpdate(connection.id, false, () => undefined)

    expect(restartWatchOf(connection.id).seen).toBe(true)
    installedOnServer(gateway)
    await first.finish()
  })
})

describe('schemaSeenOf: the store versions the Finish page keeps beyond one mount', () => {
  const withSchema = (minSchema: number): ServerCheck => ({ kind: 'ready', health: { ...FAKE_PLUGIN_HEALTH, store: { plugin_schema_version: 1, min_schema_version: minSchema, writable: true } }, update: null, hermesVersion: null })

  it('has seen nothing for a connection that never folded a poll', () => {
    expect(schemaSeenOf('c-9')).toBeNull()
  })

  it('keeps the highest min_schema_version any poll showed, for a page that mounts again', () => {
    watchUpdateSchema('c-4', withSchema(3))
    watchUpdateSchema('c-4', withSchema(2))
    watchUpdateSchema('c-4', { kind: 'not_loaded', hermesVersion: null })

    // A new page reads the same, before and after it folds its own first poll.
    expect(schemaSeenOf('c-4')).toBe(3)
    expect(watchUpdateSchema('c-4', null)).toBe(3)
  })

  it('is kept per connection', () => {
    watchUpdateSchema('c-3', withSchema(4))

    expect(schemaSeenOf('c-2')).toBeNull()
  })

  it('starts again when a new update run starts, with the restart watch', async () => {
    watchUpdateSchema(connection.id, withSchema(5))

    const running = start(runningServer())
    expect(schemaSeenOf(connection.id)).toBeNull()
    await running.finish()
  })

  it('stays when a call only joins the run that is going', async () => {
    const gateway = runningServer()
    gateway.plugins.fail('install', networkError())
    const first = start(gateway)
    await vi.advanceTimersByTimeAsync(2_000)
    watchUpdateSchema(connection.id, withSchema(5))

    void joinUpdate(connection.id, false, () => undefined)

    expect(schemaSeenOf(connection.id)).toBe(5)
    installedOnServer(gateway)
    await first.finish()
  })
})

describe('the Finish page after it mounts again', () => {
  const FAILED_UPDATE = { target: TARGET, previous: OLD, previousSchema: 1 }
  const notLoaded: ServerCheck = { kind: 'not_loaded', hermesVersion: '0.21.7' }

  /** What a Finish page that mounts now builds from the connection and from what the update run and the polls left in memory; after a relaunch that memory is empty. */
  function freshPage(check: ServerCheck, { relaunched = false, setup = { state: 'pending' } as SetupProgress } = {}) {
    const last = relaunched ? null : lastUpdateRun(connection.id)
    const restartSeen = relaunched ? false : restartWatchOf(connection.id).seen
    const update = finishUpdateOf({ started: stored().pluginUpdate, schemaSeen: null, last, restartSeen, wentBack: stored().pluginWentBack })
    return finishView(finishVariant(check, null, update), buildRecord(), check, setup)
  }

  /** A check whose plugin has the files of `commit` and answers with the code of `loaded`. */
  function checkAt(kind: 'ready' | 'restart_needed' | 'outdated', commit: string, loaded: string = commit): ServerCheck {
    const health = { ...FAKE_PLUGIN_HEALTH, install: { kind: 'git install', commit, loaded_commit: loaded, catalog_name: null } } as const
    switch (kind) {
      case 'ready':
        return { kind, health, update: null, hermesVersion: null }
      case 'restart_needed':
        return { kind, health, hermesVersion: null }
      case 'outdated':
        return { kind, health, installKind: 'git install', update: null, hermesVersion: null }
    }
  }

  it('keeps the sign of the restart, so a plugin that does not come up is a new version that did not start', async () => {
    await run(runningServer())
    expect(freshPage(notLoaded).intro).toEqual(['The update is installed. Restart Hermes to start the new version.'])

    // The earlier page saw the server refuse the session after the restart, then the user signed in again and the page mounted anew.
    watchUpdateRestart(connection.id, null, true)

    expect(freshPage(notLoaded)).toMatchObject({ intro: ['The new version did not start.', expect.any(String)], primary: { label: 'Go back to the previous version', action: 'go_back' } })
  })

  it('does not offer to go back after a new update run started, until a new sign shows', async () => {
    await run(runningServer())
    watchUpdateRestart(connection.id, null, true)

    await run(runningServer())

    expect(freshPage(notLoaded).intro).toEqual(['The update is installed. Restart Hermes to start the new version.'])
  })

  it('asks for the restart of the previous version when the going back ended asking for it', async () => {
    const gateway = runningServer()
    gateway.plugins.installedCommit = TARGET
    markPendingSetup(connection.id, TARGET)
    useDeviceStore.getState().updateConnection(connection.id, { pluginUpdate: FAILED_UPDATE })
    gateway.ergates.setHealth(notLoadedThen({ state: 'answered', health: { ...FAKE_PLUGIN_HEALTH, install: { kind: 'git install', commit: OLD, loaded_commit: TARGET, catalog_name: null } } }))

    const result = await run(gateway, { target: OLD, goingBack: true })
    const mixed = checkAt('restart_needed', OLD, TARGET)

    expect(result.outcome).toEqual({ kind: 'restart' })
    for (const relaunched of [false, true]) {
      expect(freshPage(mixed, { relaunched })).toMatchObject({ intro: ['The previous version is installed. Restart Hermes to start it.'], primary: { label: 'Check now', action: 'check' } })
    }
    // Hermes has not loaded anything yet: the page does not offer a second go back to the commit that is already installed.
    expect(freshPage(notLoaded).primary).toEqual({ label: 'Check now', action: 'check' })
  })

  it('says the previous version is back once the going back went through, after a relaunch too', async () => {
    const gateway = runningServer()
    gateway.plugins.installedCommit = TARGET
    markPendingSetup(connection.id, TARGET)
    useDeviceStore.getState().updateConnection(connection.id, { pluginUpdate: FAILED_UPDATE })
    gateway.ergates.setHealth(() => ({ state: 'answered', health: { ...FAKE_PLUGIN_HEALTH, install: { kind: 'git install', commit: OLD, loaded_commit: OLD, catalog_name: null } } }))

    const result = await run(gateway, { target: OLD, goingBack: true })

    expect(result.outcome).toMatchObject({ kind: 'done' })
    expect(stored().pluginUpdate).toBeUndefined()
    for (const relaunched of [false, true]) {
      expect(freshPage(checkAt('ready', OLD), { relaunched, setup: { state: 'done' } }).status).toBe('The previous version is back. Your server is ready.')
      expect(freshPage(checkAt('outdated', OLD), { relaunched }).intro).toEqual([
        'The previous version is back, but this app needs a newer plugin. The update did not start on your server.',
        'The guide shows what to check before you try again.'
      ])
    }
  })

  it('reads a restart for another commit, later, as about that commit and not the going back', async () => {
    const gateway = runningServer()
    gateway.plugins.installedCommit = TARGET
    useDeviceStore.getState().updateConnection(connection.id, { pluginUpdate: FAILED_UPDATE })
    gateway.ergates.setHealth(() => ({ state: 'answered', health: { ...FAKE_PLUGIN_HEALTH, install: { kind: 'git install', commit: OLD, loaded_commit: OLD, catalog_name: null } } }))
    await run(gateway, { target: OLD, goingBack: true })

    expect(freshPage(checkAt('restart_needed', 'e'.repeat(40), OLD)).intro).toEqual(['The update is installed. Restart Hermes to start the new version.'])
  })
})
