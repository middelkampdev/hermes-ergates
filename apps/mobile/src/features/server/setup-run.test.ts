/**
 * The setup run installs, enables and starts the plugin from whatever state
 * the server is in, and runs the plugin's setup once at the end. The tests
 * drive it with FakeGateway; the server's health answer follows the plugin
 * list, as a Hermes that mounts a plugin when it is enabled does.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { GatewayError, mapHttpError } from '@/gateway/errors'
import { PLUGIN_INSTALL_TIMEOUT_MS } from '@/gateway/port'
import { mapPluginInstallError } from '@/gateway/real/plugins-api'
import type { HermesPluginRow, PluginInstallCode, PluginProbe } from '@/gateway/types'
import { useDeviceStore, type Connection } from '@/state/device-store'
import { FAKE_PLUGIN_HEALTH, FAKE_SETUP } from '@test/fake-gateway/fake-ergates'
import { FakeGateway } from '@test/fake-gateway/fake-gateway'

import { PLUGIN_IDENTIFIER, type BuildRecord } from './build-record'
import { finishPendingSetup } from './pending-setup'
import { isSetupRunning, lastManualOutcome, runSetup, type SetupOutcome, type SetupStep, type StepStatus } from './setup-run'

const COMMIT = 'c'.repeat(40)
const LOST = 'Lost the connection to your server during setup.'

const connection: Connection = { id: 'c-1', label: 'Home server', baseUrl: 'http://100.64.0.1:9119', authMode: 'token', primary: true, createdAt: 1 }

function buildRecord(commit: string | null = COMMIT): BuildRecord {
  return { requiredPlugin: { version: '0.2.0', apiLevel: 1, commit }, hermesRange: { oldest: '0.21.6', newestMinor: '0.21' } }
}

function row(runtime_status: HermesPluginRow['runtime_status']): HermesPluginRow {
  return { name: 'ergates', version: '0.2.0', runtime_status }
}

function flag(): string | undefined {
  return useDeviceStore.getState().connections.find(found => found.id === connection.id)?.pendingPluginSetup
}

/** What Hermes answers for the plugin's health: it serves the plugin once the plugin list shows it enabled. */
function mountsWhenEnabled(gateway: FakeGateway, whenEnabled: PluginProbe = { state: 'answered', health: FAKE_PLUGIN_HEALTH }): () => PluginProbe {
  return () => (gateway.plugins.rows.some(found => found.name === 'ergates' && found.runtime_status === 'enabled') ? whenEnabled : { state: 'absent' })
}

/** A server without the plugin. */
function freshServer(): FakeGateway {
  const gateway = new FakeGateway()
  gateway.plugins.rows = []
  gateway.ergates.setHealth(mountsWhenEnabled(gateway))
  return gateway
}

/** A server that lists the plugin in `status`. */
function serverListing(status: HermesPluginRow['runtime_status']): FakeGateway {
  const gateway = freshServer()
  gateway.plugins.rows = [row(status)]
  return gateway
}

type Transition = [SetupStep, StepStatus]

interface Run {
  outcome: SetupOutcome
  transitions: Transition[]
  /** The last status each step reported. */
  last: Partial<Record<SetupStep, StepStatus>>
}

/** Starts a run; `finish` lets every wait elapse and settles it. */
function start(gateway: FakeGateway, build: BuildRecord = buildRecord()) {
  const transitions: Transition[] = []
  const promise = runSetup({ port: gateway, build, connectionId: connection.id }, (step, status) => transitions.push([step, status]))
  let outcome: SetupOutcome | null = null
  void promise.then(settled => {
    outcome = settled
  })
  return {
    transitions,
    promise,
    /** The outcome once the run has ended, null while it is still going. */
    get settled(): SetupOutcome | null {
      return outcome
    },
    async finish(): Promise<Run> {
      await vi.runAllTimersAsync()
      return { outcome: await promise, transitions, last: Object.fromEntries(transitions) }
    }
  }
}

function run(gateway: FakeGateway, build?: BuildRecord): Promise<Run> {
  return start(gateway, build).finish()
}

function healthCalls(gateway: FakeGateway): number {
  return gateway.ergates.calls.filter(call => call.op === 'health').length
}

const networkError = () => new GatewayError('network', 'Could not reach the gateway.')

beforeEach(() => {
  vi.useFakeTimers()
  useDeviceStore.setState({ connections: [{ ...connection }] })
})

afterEach(async () => {
  // A run that a test left waiting would otherwise be joined by the next test's run.
  await vi.runAllTimersAsync()
  vi.useRealTimers()
})

describe('runSetup: a server without the plugin', () => {
  it('installs it at the build commit, starts it and runs the setup once', async () => {
    const gateway = freshServer()

    const result = await run(gateway)

    expect(result.outcome).toEqual({ kind: 'done', setup: FAKE_SETUP })
    expect(result.transitions).toEqual([
      ['install', 'active'],
      ['install', 'done'],
      ['enable', 'skipped'],
      ['start', 'active'],
      ['start', 'done'],
      ['setup', 'active'],
      ['setup', 'done']
    ])
    expect(gateway.plugins.installs).toEqual([{ identifier: PLUGIN_IDENTIFIER, ref: COMMIT, enable: true, force: false }])
    expect(gateway.plugins.enabled).toEqual([])
    expect(gateway.ergates.setupCalls).toBe(1)
    expect(flag()).toBeUndefined()
  })

  it('marks the pending setup before it asks the server anything', async () => {
    const gateway = freshServer()
    const seen: (string | undefined)[] = []
    const probe = mountsWhenEnabled(gateway)
    gateway.ergates.setHealth(() => {
      seen.push(flag())
      return probe()
    })

    await run(gateway)

    expect(seen[0]).toBe(COMMIT)
  })

  it('looks for the plugin up to three times, 2 seconds apart, before it runs the setup', async () => {
    const gateway = freshServer()
    const answers: PluginProbe[] = [{ state: 'absent' }, { state: 'absent' }, { state: 'absent' }, { state: 'answered', health: FAKE_PLUGIN_HEALTH }]
    gateway.ergates.setHealth(() => answers.shift() ?? { state: 'answered', health: FAKE_PLUGIN_HEALTH })
    const running = start(gateway)

    await vi.advanceTimersByTimeAsync(1_999)
    expect(healthCalls(gateway)).toBe(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(healthCalls(gateway)).toBe(3)
    await vi.advanceTimersByTimeAsync(2_000)

    expect(healthCalls(gateway)).toBe(4)
    expect(running.settled).toMatchObject({ kind: 'done' })
  })

  it('fails when Hermes never loads the plugin, and keeps the pending setup', async () => {
    const gateway = freshServer()
    gateway.ergates.setHealth({ state: 'absent' })

    const result = await run(gateway)

    expect(result.outcome).toEqual({ kind: 'failed', step: 'start', message: 'Hermes did not load the plugin.' })
    expect(result.last).toMatchObject({ install: 'done', start: 'failed' })
    expect(healthCalls(gateway)).toBe(4)
    expect(gateway.ergates.setupCalls).toBe(0)
    expect(flag()).toBe(COMMIT)
  })

  it('asks for a restart when the plugin is enabled but Hermes does not serve its routes', async () => {
    const gateway = freshServer()
    gateway.ergates.setHealth(mountsWhenEnabled(gateway, { state: 'not_loaded' }))

    const result = await run(gateway)

    expect(result.outcome).toEqual({ kind: 'restart' })
    expect(result.last).toMatchObject({ install: 'done', enable: 'skipped', start: 'failed' })
    expect(gateway.ergates.setupCalls).toBe(0)
    expect(flag()).toBe(COMMIT)
  })
})

describe('runSetup: a server that already has some of it', () => {
  it('skips the install and the enable when the plugin answers', async () => {
    const gateway = serverListing('enabled')

    const result = await run(gateway)

    expect(result.outcome).toMatchObject({ kind: 'done' })
    expect(result.last).toEqual({ install: 'skipped', enable: 'skipped', start: 'done', setup: 'done' })
    expect(gateway.plugins.installs).toEqual([])
    expect(gateway.ergates.setupCalls).toBe(1)
  })

  it('does not install over a listed plugin that is disabled, it enables it', async () => {
    const gateway = serverListing('disabled')

    const result = await run(gateway)

    expect(result.outcome).toMatchObject({ kind: 'done' })
    expect(result.last).toEqual({ install: 'skipped', enable: 'done', start: 'done', setup: 'done' })
    expect(gateway.plugins.installs).toEqual([])
    expect(gateway.plugins.enabled).toEqual(['ergates'])
  })

  it('continues with enable when the install finds the plugin already there', async () => {
    // The plugin list fails once, so the run tries to install over a plugin Hermes already holds.
    const gateway = serverListing('disabled')
    gateway.plugins.fail('hub', new GatewayError('unknown', 'The gateway had an internal problem.', { status: 500 }))

    const result = await run(gateway)

    expect(result.outcome).toMatchObject({ kind: 'done' })
    expect(result.last).toEqual({ install: 'done', enable: 'done', start: 'done', setup: 'done' })
    expect(gateway.plugins.installs).toHaveLength(1)
    expect(gateway.plugins.enabled).toEqual(['ergates'])
    expect(gateway.ergates.setupCalls).toBe(1)
  })

  it('asks for a restart when the plugin is enabled but not mounted, without installing', async () => {
    const gateway = serverListing('enabled')
    gateway.ergates.setHealth({ state: 'not_loaded' })

    const result = await run(gateway)

    expect(result.outcome).toEqual({ kind: 'restart' })
    expect(result.last).toMatchObject({ install: 'skipped', enable: 'skipped' })
    expect(gateway.plugins.installs).toEqual([])
  })
})

describe('runSetup: the install request is lost', () => {
  it('goes on when the install finished on the server while the answer was lost', async () => {
    const gateway = freshServer()
    gateway.plugins.fail('install', networkError(), 'after')

    const result = await run(gateway)

    expect(result.outcome).toMatchObject({ kind: 'done' })
    expect(result.last).toEqual({ install: 'done', enable: 'skipped', start: 'done', setup: 'done' })
    expect(gateway.plugins.installs).toHaveLength(1)
    expect(gateway.ergates.setupCalls).toBe(1)
  })

  it('keeps the install active and checks every 5 seconds until the plugin appears', async () => {
    const gateway = freshServer()
    gateway.plugins.fail('install', networkError())
    const running = start(gateway)

    await vi.advanceTimersByTimeAsync(12_000)
    // Nothing arrived yet: the step is still waiting and nothing was installed twice.
    expect(running.transitions).toEqual([['install', 'active']])
    expect(gateway.plugins.installs).toHaveLength(1)
    gateway.plugins.rows = [row('enabled')]
    await vi.advanceTimersByTimeAsync(3_000)

    const result = await running.finish()
    expect(result.outcome).toMatchObject({ kind: 'done' })
    expect(result.last).toEqual({ install: 'done', enable: 'skipped', start: 'done', setup: 'done' })
    expect(gateway.plugins.installs).toHaveLength(1)
    expect(gateway.ergates.setupCalls).toBe(1)
  })

  it('looks again right after the loss and then every 5 seconds, no more often and no less', async () => {
    const gateway = freshServer()
    gateway.plugins.fail('install', networkError())
    const hub = vi.spyOn(gateway.plugins, 'hub')
    const running = start(gateway)

    // The first look at the plugin is the check before the install; the second follows the loss at once.
    await vi.advanceTimersByTimeAsync(0)
    expect([healthCalls(gateway), hub.mock.calls.length]).toEqual([2, 2])
    await vi.advanceTimersByTimeAsync(4_999)
    expect([healthCalls(gateway), hub.mock.calls.length]).toEqual([2, 2])
    await vi.advanceTimersByTimeAsync(1)
    expect([healthCalls(gateway), hub.mock.calls.length]).toEqual([3, 3])
    await vi.advanceTimersByTimeAsync(4_999)
    expect([healthCalls(gateway), hub.mock.calls.length]).toEqual([3, 3])
    await vi.advanceTimersByTimeAsync(1)
    expect([healthCalls(gateway), hub.mock.calls.length]).toEqual([4, 4])
    expect(running.settled).toBeNull()
    gateway.plugins.rows = [row('enabled')]
    await running.finish()
  })

  it.each([
    ['times out', new GatewayError('timeout', 'The gateway took too long to answer.')],
    ['answers 502 from a proxy', new GatewayError('unknown', 'The gateway had an internal problem.', { status: 502 })],
    ['answers 504 from a proxy', new GatewayError('unknown', 'The gateway had an internal problem.', { status: 504 })]
  ])('treats an install that %s as lost, not refused', async (_title, error) => {
    const gateway = freshServer()
    gateway.plugins.fail('install', error)
    const running = start(gateway)
    await vi.advanceTimersByTimeAsync(5_000)
    gateway.plugins.rows = [row('enabled')]

    const result = await running.finish()

    expect(result.outcome).toMatchObject({ kind: 'done' })
    expect(gateway.plugins.installs).toHaveLength(1)
  })

  it('enables a plugin that appeared without being enabled', async () => {
    const gateway = freshServer()
    gateway.plugins.fail('install', networkError())
    const running = start(gateway)
    await vi.advanceTimersByTimeAsync(5_000)
    gateway.plugins.rows = [row('inactive')]

    const result = await running.finish()

    expect(result.outcome).toMatchObject({ kind: 'done' })
    expect(result.last).toEqual({ install: 'done', enable: 'done', start: 'done', setup: 'done' })
    expect(gateway.plugins.enabled).toEqual(['ergates'])
  })

  it('fails with the lost connection once the install time has passed, and keeps the pending setup', async () => {
    const gateway = freshServer()
    gateway.plugins.fail('install', networkError())
    const running = start(gateway)

    await vi.advanceTimersByTimeAsync(PLUGIN_INSTALL_TIMEOUT_MS - 1)
    expect(running.settled).toBeNull()
    await vi.advanceTimersByTimeAsync(1)

    expect(running.settled).toEqual({ kind: 'failed', step: 'install', message: LOST })
    const result = await running.finish()
    expect(result.last).toEqual({ install: 'failed' })
    expect(gateway.plugins.installs).toHaveLength(1)
    expect(gateway.ergates.setupCalls).toBe(0)
    expect(flag()).toBe(COMMIT)
  })

  it('counts the install time from the request, so a request that ran long leaves little to wait', async () => {
    const gateway = freshServer()
    const requestRuns = PLUGIN_INSTALL_TIMEOUT_MS - 20_000
    gateway.plugins.install = async () => {
      await new Promise(resolve => setTimeout(resolve, requestRuns))
      throw new GatewayError('timeout', 'The gateway took too long to answer.')
    }
    const running = start(gateway)

    await vi.advanceTimersByTimeAsync(requestRuns + 19_999)
    expect(running.settled).toBeNull()
    await vi.advanceTimersByTimeAsync(1)

    expect(running.settled).toEqual({ kind: 'failed', step: 'install', message: LOST })
  })

  it('asks to sign in again when the server stops accepting the sign-in while the run waits', async () => {
    const gateway = freshServer()
    gateway.plugins.fail('install', networkError())
    let reads = 0
    gateway.ergates.setHealth(() => {
      reads += 1
      return reads === 1 ? { state: 'absent' } : new GatewayError('unauthorized', 'Sign-in required.')
    })

    const result = await run(gateway)

    expect(result.outcome).toEqual({ kind: 'sign_in' })
    expect(result.last).toEqual({ install: 'failed' })
    expect(flag()).toBe(COMMIT)
  })
})

describe('runSetup: Hermes refuses', () => {
  it.each<PluginInstallCode>(['scan_blocked', 'no_git', 'download_failed', 'enable_refused'])('ends in the manual path for %s', async code => {
    const gateway = freshServer()
    gateway.plugins.nextInstall(new GatewayError('unknown', 'Hermes words this its own way.', { code, status: 400 }))

    const result = await run(gateway)

    expect(result.outcome).toEqual({ kind: 'manual', failure: code, detail: null })
    expect(result.last).toEqual({ install: 'failed' })
    expect(gateway.ergates.setupCalls).toBe(0)
    expect(flag()).toBe(COMMIT)
  })

  it('ends in the manual path with Hermes\'s own text when a 400 has no code', async () => {
    const gateway = freshServer()
    gateway.plugins.nextInstall(mapPluginInstallError(400, { detail: 'Something Hermes says in its own words.' }))

    const result = await run(gateway)

    expect(result.outcome).toEqual({ kind: 'manual', failure: 'refused', detail: 'Something Hermes says in its own words.' })
    expect(result.last).toEqual({ install: 'failed' })
  })

  it('fails the install step for an answer that is not a refusal', async () => {
    const gateway = freshServer()
    gateway.plugins.nextInstall(mapHttpError(403, { detail: 'Not allowed.' }))

    const result = await run(gateway)

    expect(result.outcome).toEqual({ kind: 'failed', step: 'install', message: 'Not allowed.' })
    expect(result.last).toEqual({ install: 'failed' })
  })

  it('ends in the manual path with the text when the enable route refuses with a 400', async () => {
    const error = mapHttpError(400, { detail: "Plugin 'ergates' is not installed or bundled." })
    const gateway = serverListing('disabled')
    gateway.plugins.fail('enable', error)

    const result = await run(gateway)

    expect(result.outcome).toEqual({ kind: 'manual', failure: 'enable_refused', detail: error.message })
    expect(result.last).toMatchObject({ install: 'skipped', enable: 'failed' })
    expect(flag()).toBe(COMMIT)
  })

  it.each([
    ['gets no answer', new GatewayError('network', 'Could not reach the gateway.')],
    ['times out', new GatewayError('timeout', 'The gateway took too long to answer.')],
    ['fails with a 500', mapHttpError(500, { detail: 'Internal.' })],
    ['is answered 502 by a proxy', new GatewayError('unknown', 'The gateway had an internal problem.', { status: 502 })]
  ])('fails the enable step, so the user can try again, when the enable request %s', async (_title, error) => {
    const gateway = serverListing('disabled')
    gateway.plugins.fail('enable', error)

    const result = await run(gateway)

    expect(result.outcome).toEqual({ kind: 'failed', step: 'enable', message: error.message })
    expect(result.last).toMatchObject({ install: 'skipped', enable: 'failed' })
    expect(flag()).toBe(COMMIT)
  })

  it('fails the setup step and keeps the pending setup when the setup does not run', async () => {
    const gateway = freshServer()
    gateway.ergates.fail('setup', new GatewayError('unknown', 'The request could not be completed.', { status: 500 }))

    const result = await run(gateway)

    expect(result.outcome).toEqual({ kind: 'failed', step: 'setup', message: 'The request could not be completed.' })
    expect(result.last).toMatchObject({ start: 'done', setup: 'failed' })
    expect(flag()).toBe(COMMIT)
  })

  it('reports an unexpected error without its text', async () => {
    const gateway = freshServer()
    gateway.ergates.setHealth(() => {
      throw new TypeError('x is not a function')
    })

    const result = await run(gateway)

    expect(result.outcome).toEqual({ kind: 'failed', step: 'install', message: 'Something went wrong during setup.' })
  })
})

describe('runSetup: one run per connection', () => {
  const steps = (log: Transition[]) => (step: SetupStep, status: StepStatus) => {
    log.push([step, status])
  }

  it('joins a run that is still waiting on a lost install instead of starting another', async () => {
    const gateway = freshServer()
    gateway.plugins.fail('install', networkError())
    const first = start(gateway)
    await vi.advanceTimersByTimeAsync(7_000)
    expect(first.transitions).toEqual([['install', 'active']])

    const joined: Transition[] = []
    const second = runSetup({ port: gateway, build: buildRecord(), connectionId: connection.id }, steps(joined))
    // The joiner is told where the run is at once.
    expect(joined).toEqual([['install', 'active']])
    gateway.plugins.rows = [row('enabled')]
    const result = await first.finish()

    const everything: Transition[] = [
      ['install', 'active'],
      ['install', 'done'],
      ['enable', 'skipped'],
      ['start', 'active'],
      ['start', 'done'],
      ['setup', 'active'],
      ['setup', 'done']
    ]
    expect(result.outcome).toMatchObject({ kind: 'done' })
    await expect(second).resolves.toEqual(result.outcome)
    expect(first.transitions).toEqual(everything)
    expect(joined).toEqual(everything)
    expect(gateway.plugins.installs).toHaveLength(1)
    expect(gateway.ergates.setupCalls).toBe(1)
  })

  it('tells a joiner the current status of every step that has reported, in order', async () => {
    const gateway = freshServer()
    gateway.ergates.setHealth(() => ({ state: 'absent' }))
    const first = start(gateway)
    await vi.advanceTimersByTimeAsync(1_000)

    const joined: Transition[] = []
    const second = runSetup({ port: gateway, build: buildRecord(), connectionId: connection.id }, steps(joined))

    expect(joined).toEqual([
      ['install', 'done'],
      ['enable', 'skipped'],
      ['start', 'active']
    ])
    const result = await first.finish()
    expect(result.outcome).toEqual({ kind: 'failed', step: 'start', message: 'Hermes did not load the plugin.' })
    await expect(second).resolves.toEqual(result.outcome)
    expect(joined.slice(3)).toEqual([['start', 'failed']])
  })

  it('starts a fresh run once the earlier one has ended', async () => {
    const gateway = freshServer()
    const firstRun = await run(gateway)
    expect(firstRun.outcome).toMatchObject({ kind: 'done' })

    const secondRun = await run(gateway)

    expect(secondRun.outcome).toMatchObject({ kind: 'done' })
    expect(secondRun.last).toEqual({ install: 'skipped', enable: 'skipped', start: 'done', setup: 'done' })
    expect(gateway.ergates.setupCalls).toBe(2)
    expect(gateway.plugins.installs).toHaveLength(1)
  })

  it('says a run is going from the moment it starts until it ends, for its connection only', async () => {
    const gateway = freshServer()
    gateway.plugins.fail('install', networkError())
    expect(isSetupRunning(connection.id)).toBe(false)

    const running = start(gateway)
    await vi.advanceTimersByTimeAsync(1_000)

    expect(isSetupRunning(connection.id)).toBe(true)
    expect(isSetupRunning('c-2')).toBe(false)
    gateway.plugins.rows = [row('enabled')]
    await running.finish()
    expect(isSetupRunning(connection.id)).toBe(false)
  })

  it('says no run is going after one that ended in a failure', async () => {
    const gateway = freshServer()
    gateway.ergates.setHealth({ state: 'absent' })

    const result = await run(gateway)

    expect(result.outcome).toMatchObject({ kind: 'failed' })
    expect(isSetupRunning(connection.id)).toBe(false)
  })

  it('does not start a second setup for a ready check while a run is going, and does again once it ended', async () => {
    const gateway = freshServer()
    gateway.plugins.fail('install', networkError())
    const running = start(gateway)
    await vi.advanceTimersByTimeAsync(1_000)
    // The plugin showed up, but the run has not noticed yet.
    gateway.plugins.rows = [row('enabled')]
    const pending = useDeviceStore.getState().connections[0]

    const during = await finishPendingSetup(gateway, pending, { kind: 'ready', health: FAKE_PLUGIN_HEALTH, update: null, hermesVersion: null })

    expect(during).toBeNull()
    expect(gateway.ergates.setupCalls).toBe(0)
    expect(flag()).toBe(COMMIT)

    await running.finish()
    expect(gateway.ergates.setupCalls).toBe(1)
    expect(flag()).toBeUndefined()
  })

  it('lets a ready check finish a pending setup once the run that left it has ended', async () => {
    const gateway = freshServer()
    gateway.ergates.fail('setup', new GatewayError('unauthorized', 'Sign-in required.', { status: 401 }))
    await run(gateway)
    const pending = useDeviceStore.getState().connections[0]

    const report = await finishPendingSetup(gateway, pending, { kind: 'ready', health: FAKE_PLUGIN_HEALTH, update: null, hermesVersion: null })

    expect(report).toEqual(FAKE_SETUP)
  })

  it('does not join the run of another connection', async () => {
    useDeviceStore.setState({ connections: [{ ...connection }, { ...connection, id: 'c-2', label: 'Office server' }] })
    const gateway = freshServer()
    gateway.plugins.fail('install', networkError())
    const first = start(gateway)
    await vi.advanceTimersByTimeAsync(1_000)

    const other = runSetup({ port: freshServer(), build: buildRecord(), connectionId: 'c-2' }, () => undefined)

    await expect(other).resolves.toMatchObject({ kind: 'done' })
    expect(first.settled).toBeNull()
    gateway.plugins.rows = [row('enabled')]
    await first.finish()
  })
})

describe('runSetup: sign-in and the build', () => {
  it.each<[string, (gateway: FakeGateway) => void, SetupStep]>([
    ['the first health read', gateway => gateway.ergates.fail('health', new GatewayError('unauthorized', 'Sign-in required.')), 'install'],
    ['the plugin list', gateway => gateway.plugins.fail('hub', new GatewayError('unauthorized', 'Sign-in required.')), 'install'],
    ['the install', gateway => gateway.plugins.nextInstall(new GatewayError('unauthorized', 'Sign-in required.', { status: 401 })), 'install'],
    ['the enable', gateway => gateway.plugins.fail('enable', new GatewayError('unauthorized', 'Sign-in required.', { status: 401 })), 'enable']
  ])('asks to sign in again when %s answers 401', async (_where, scripted, step) => {
    const gateway = step === 'enable' ? serverListing('disabled') : freshServer()
    scripted(gateway)

    const result = await run(gateway)

    expect(result.outcome).toEqual({ kind: 'sign_in' })
    expect(result.last[step]).toBe('failed')
    expect(flag()).toBe(COMMIT)
  })

  it('keeps the pending setup when the setup answers 401, and finishes it after the next sign-in', async () => {
    const gateway = freshServer()
    gateway.ergates.fail('setup', new GatewayError('unauthorized', 'Sign-in required.', { status: 401 }))

    const result = await run(gateway)

    expect(result.outcome).toEqual({ kind: 'sign_in' })
    expect(result.last).toMatchObject({ start: 'done', setup: 'failed' })
    expect(flag()).toBe(COMMIT)
    expect(gateway.ergates.setupCalls).toBe(1)

    const pending = useDeviceStore.getState().connections[0]
    const report = await finishPendingSetup(gateway, pending, { kind: 'ready', health: FAKE_PLUGIN_HEALTH, update: null, hermesVersion: null })

    expect(report).toEqual(FAKE_SETUP)
    expect(gateway.ergates.setupCalls).toBe(2)
    expect(flag()).toBeUndefined()
  })

  it('leaves a build without a commit to the guide, touching nothing', async () => {
    const gateway = freshServer()

    const result = await run(gateway, buildRecord(null))

    expect(result.outcome).toEqual({ kind: 'manual', failure: 'refused', detail: null })
    expect(result.transitions).toEqual([])
    expect(gateway.ergates.calls).toEqual([])
    expect(gateway.plugins.installs).toEqual([])
    expect(flag()).toBeUndefined()
  })
})

describe('lastManualOutcome: what the Finish screen shows of a run that ended by hand', () => {
  const OTHER = 'c-2'

  it('holds the failure and Hermes\'s text when a run ends in the manual path', async () => {
    const gateway = freshServer()
    gateway.plugins.nextInstall(mapPluginInstallError(400, { detail: 'Something Hermes says in its own words.' }))

    await run(gateway)

    expect(lastManualOutcome(connection.id)).toEqual({ kind: 'manual', failure: 'refused', detail: 'Something Hermes says in its own words.' })
  })

  it('holds a refused enable', async () => {
    const gateway = serverListing('disabled')
    gateway.plugins.fail('enable', mapHttpError(400, { detail: 'Not allowed.' }))

    await run(gateway)

    expect(lastManualOutcome(connection.id)).toEqual({ kind: 'manual', failure: 'enable_refused', detail: 'Not allowed.' })
  })

  it('holds the manual path of a build without a commit, which runs nothing', async () => {
    await run(freshServer(), buildRecord(null))

    expect(lastManualOutcome(connection.id)).toEqual({ kind: 'manual', failure: 'refused', detail: null })
  })

  it('is there when the run settles, before anything that waited on it continues', async () => {
    const gateway = freshServer()
    gateway.plugins.nextInstall(new GatewayError('unknown', 'Hermes words this its own way.', { code: 'no_git', status: 400 }))
    let seen: unknown = 'not read'
    const running = start(gateway)
    void running.promise.then(() => {
      seen = lastManualOutcome(connection.id)
    })

    await running.finish()

    expect(seen).toEqual({ kind: 'manual', failure: 'no_git', detail: null })
  })

  it('is cleared when the next run starts, so a run that ends otherwise leaves nothing', async () => {
    const failing = freshServer()
    failing.plugins.nextInstall(new GatewayError('unknown', 'Hermes words this its own way.', { code: 'no_git', status: 400 }))
    await run(failing)
    expect(lastManualOutcome(connection.id)).not.toBeNull()

    const running = start(freshServer())
    expect(lastManualOutcome(connection.id)).toBeNull()
    const result = await running.finish()

    expect(result.outcome).toMatchObject({ kind: 'done' })
    expect(lastManualOutcome(connection.id)).toBeNull()
  })

  it.each<[string, (gateway: FakeGateway) => void]>([
    ['a restart', gateway => gateway.ergates.setHealth(mountsWhenEnabled(gateway, { state: 'not_loaded' }))],
    ['a failed step', gateway => gateway.plugins.nextInstall(mapHttpError(403, { detail: 'Not allowed.' }))],
    ['a sign-in', gateway => gateway.plugins.nextInstall(new GatewayError('unauthorized', 'Sign-in required.', { status: 401 }))]
  ])('holds nothing for %s', async (_title, scripted) => {
    const gateway = freshServer()
    scripted(gateway)

    await run(gateway)

    expect(lastManualOutcome(connection.id)).toBeNull()
  })

  it('is kept per connection', async () => {
    const gateway = freshServer()
    gateway.plugins.nextInstall(new GatewayError('unknown', 'Hermes words this its own way.', { code: 'no_git', status: 400 }))

    await run(gateway)

    expect(lastManualOutcome(OTHER)).toBeNull()
  })

  it('does not clear when a call only joins the run that is going', async () => {
    const gateway = freshServer()
    gateway.plugins.nextInstall(new GatewayError('unknown', 'Hermes words this its own way.', { code: 'no_git', status: 400 }))
    const first = start(gateway)
    const joiner = start(gateway)

    await first.finish()
    await joiner.finish()

    expect(lastManualOutcome(connection.id)).toEqual({ kind: 'manual', failure: 'no_git', detail: null })
  })
})
