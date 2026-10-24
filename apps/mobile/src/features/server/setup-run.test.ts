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
import type { ErgatesHealth, HermesPluginRow, PluginInstallCode, PluginProbe } from '@/gateway/types'
import { useDeviceStore, type Connection } from '@/state/device-store'
import { FAKE_PLUGIN_HEALTH, FAKE_SETUP } from '@test/fake-gateway/fake-ergates'
import { FakeGateway } from '@test/fake-gateway/fake-gateway'

import { PLUGIN_IDENTIFIER, type BuildRecord } from './build-record'
import { finishPendingSetup, markPendingSetup, runningKind } from './pending-setup'
import type { ServerCheck } from './server-check'
import { INSTALL_RACE_AFTER_MS, isSetupRunning, joinSetup, lastManualOutcome, runSetup, type SetupOutcome, type SetupStep, type StepStatus } from './setup-run'

const COMMIT = 'c'.repeat(40)
const LOST = 'Lost the connection to your server during setup.'

const connection: Connection = { id: 'c-1', label: 'Home server', baseUrl: 'http://100.64.0.1:9119', authMode: 'token', primary: true, createdAt: 1 }

function buildRecord(commit: string | null = COMMIT): BuildRecord {
  return { requiredPlugin: { version: '0.2.0', apiLevel: 1, commit }, hermesRange: { oldest: '0.21.6', newestMinor: '0.21' } }
}

function row(runtime_status: HermesPluginRow['runtime_status']): HermesPluginRow {
  return { name: 'ergates', version: '0.2.0', runtime_status }
}

/** The health of a git install whose record names `commit` and whose code was loaded from `loaded`, or `'unreported'` for a plugin that does not say. */
function healthAt(commit: string, loaded: string | null | 'unreported' = commit): ErgatesHealth {
  const install: NonNullable<ErgatesHealth['install']> = { kind: 'git install', commit, catalog_name: null }
  if (loaded !== 'unreported') {
    install.loaded_commit = loaded
  }
  return { ...FAKE_PLUGIN_HEALTH, install }
}

/** What a plugin installed from the build's commit answers. */
const SERVED: ErgatesHealth = healthAt(COMMIT)

/** The check of a plugin that runs the commit the run installed. */
function readyCheck(health: ErgatesHealth = SERVED): ServerCheck {
  return { kind: 'ready', health, update: null, hermesVersion: null }
}

function flag(): string | undefined {
  return useDeviceStore.getState().connections.find(found => found.id === connection.id)?.pendingPluginSetup
}

/**
 * What Hermes answers for the plugin's health: it serves the plugin once the plugin list shows it enabled,
 * and answers `whenOff` until then.
 */
function mountsWhenEnabled(
  gateway: FakeGateway,
  whenEnabled: PluginProbe = { state: 'answered', health: SERVED },
  whenOff: PluginProbe = { state: 'absent' }
): () => PluginProbe {
  return () => (gateway.plugins.rows.some(found => found.name === 'ergates' && found.runtime_status === 'enabled') ? whenEnabled : whenOff)
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

  it('marks the pending setup once the first look at the server worked, before it installs anything', async () => {
    const gateway = freshServer()
    const seen: (string | undefined)[] = []
    const probe = mountsWhenEnabled(gateway)
    gateway.ergates.setHealth(() => {
      seen.push(flag())
      return probe()
    })
    const install = gateway.plugins.install.bind(gateway.plugins)
    const atInstall: (string | undefined)[] = []
    gateway.plugins.install = req => {
      atInstall.push(flag())
      return install(req)
    }

    await run(gateway)

    expect(seen[0]).toBeUndefined()
    expect(atInstall).toEqual([COMMIT])
  })

  it.each([
    ['refuses the session', () => new GatewayError('unauthorized', 'Sign-in required.', { status: 401 }), { kind: 'sign_in' }],
    ['cannot be reached', () => new GatewayError('network', 'Could not reach the gateway.'), { kind: 'failed', step: 'install', message: 'Could not reach the gateway.' }]
  ])('marks no pending setup when the server %s at the first look', async (_title, error, outcome) => {
    const gateway = freshServer()
    gateway.ergates.fail('health', error())

    const result = await run(gateway)

    expect(result.outcome).toEqual(outcome)
    expect(flag()).toBeUndefined()
    expect(gateway.plugins.installs).toEqual([])
  })

  it('looks for the plugin up to three times, 2 seconds apart, before it runs the setup', async () => {
    const gateway = freshServer()
    const answers: PluginProbe[] = [{ state: 'absent' }, { state: 'absent' }, { state: 'absent' }, { state: 'answered', health: SERVED }]
    gateway.ergates.setHealth(() => answers.shift() ?? { state: 'answered', health: SERVED })
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
    expect(result.last).toMatchObject({ install: 'done', enable: 'skipped', start: 'pending' })
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

describe('runSetup: Hermes finds no routes for the plugin', () => {
  it('installs when the plugin list does not hold the plugin, as when its folder is gone but its name is still enabled', async () => {
    const gateway = freshServer()
    gateway.ergates.setHealth(mountsWhenEnabled(gateway, { state: 'answered', health: SERVED }, { state: 'not_loaded' }))

    const result = await run(gateway)

    expect(result.outcome).toMatchObject({ kind: 'done' })
    expect(result.last).toEqual({ install: 'done', enable: 'skipped', start: 'done', setup: 'done' })
    expect(gateway.plugins.installs).toHaveLength(1)
  })

  it('does not install over a listed plugin, and enables it when the list shows it off', async () => {
    const gateway = serverListing('disabled')
    gateway.ergates.setHealth({ state: 'not_loaded' })

    const result = await run(gateway)

    expect(result.outcome).toEqual({ kind: 'restart' })
    expect(result.last).toMatchObject({ install: 'skipped', enable: 'done', start: 'pending' })
    expect(gateway.plugins.installs).toEqual([])
    expect(gateway.plugins.enabled).toEqual(['ergates'])
  })

  it('does not install when the plugin list cannot be read: the health read says the plugin is there', async () => {
    const gateway = freshServer()
    gateway.ergates.setHealth({ state: 'not_loaded' })
    gateway.plugins.fail('hub', networkError())

    const result = await run(gateway)

    expect(result.outcome).toEqual({ kind: 'restart' })
    expect(result.last).toMatchObject({ install: 'skipped', enable: 'skipped', start: 'pending' })
    expect(gateway.plugins.installs).toEqual([])
    expect(gateway.plugins.enabled).toEqual([])
  })

  it('installs when the health read finds the plugin absent and the plugin list cannot be read', async () => {
    const gateway = freshServer()
    gateway.plugins.fail('hub', networkError())

    const result = await run(gateway)

    expect(result.outcome).toMatchObject({ kind: 'done' })
    expect(gateway.plugins.installs).toHaveLength(1)
  })

  it('does not count a lost install as arrived while the list does not hold the plugin', async () => {
    const gateway = freshServer()
    gateway.ergates.setHealth({ state: 'not_loaded' })
    gateway.plugins.fail('install', networkError())
    const running = start(gateway)

    await vi.advanceTimersByTimeAsync(PLUGIN_INSTALL_TIMEOUT_MS)

    expect(running.settled).toEqual({ kind: 'failed', step: 'install', message: LOST })
    expect(gateway.plugins.installs).toHaveLength(1)
    await running.finish()
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

describe('runSetup: the install request does not answer', () => {
  function hungInstall(): FakeGateway {
    const gateway = freshServer()
    gateway.plugins.fail('install', 'hang')
    return gateway
  }

  it('looks again only after a minute, and then every 5 seconds', async () => {
    const gateway = hungInstall()
    const hub = vi.spyOn(gateway.plugins, 'hub')
    const running = start(gateway)

    // The first look at the plugin is the check before the install.
    await vi.advanceTimersByTimeAsync(INSTALL_RACE_AFTER_MS - 1)
    expect([healthCalls(gateway), hub.mock.calls.length]).toEqual([1, 1])
    await vi.advanceTimersByTimeAsync(1)
    expect([healthCalls(gateway), hub.mock.calls.length]).toEqual([2, 2])
    await vi.advanceTimersByTimeAsync(4_999)
    expect(healthCalls(gateway)).toBe(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(healthCalls(gateway)).toBe(3)
    expect(running.settled).toBeNull()
    gateway.plugins.rows = [row('enabled')]
    await running.finish()
  })

  it('goes on as soon as the plugin shows up, and sends no second install', async () => {
    const gateway = hungInstall()
    const running = start(gateway)
    await vi.advanceTimersByTimeAsync(66_000)
    gateway.plugins.rows = [row('enabled')]

    await vi.advanceTimersByTimeAsync(3_999)
    expect(running.settled).toBeNull()
    expect(running.transitions).toEqual([['install', 'active']])
    await vi.advanceTimersByTimeAsync(1)

    expect(running.settled).toMatchObject({ kind: 'done' })
    expect(running.transitions).toEqual([
      ['install', 'active'],
      ['install', 'done'],
      ['enable', 'skipped'],
      ['start', 'active'],
      ['start', 'done'],
      ['setup', 'active'],
      ['setup', 'done']
    ])
    expect(gateway.plugins.installs).toHaveLength(1)
    expect(gateway.ergates.setupCalls).toBe(1)
    expect(flag()).toBeUndefined()
  })

  it('enables a plugin that showed up without being enabled', async () => {
    const gateway = hungInstall()
    const running = start(gateway)
    await vi.advanceTimersByTimeAsync(61_000)
    gateway.plugins.rows = [row('inactive')]

    const result = await running.finish()

    expect(result.outcome).toMatchObject({ kind: 'done' })
    expect(result.last).toEqual({ install: 'done', enable: 'done', start: 'done', setup: 'done' })
    expect(gateway.plugins.enabled).toEqual(['ergates'])
  })

  it('carries on with the answer when the install answers while the run looks', async () => {
    const gateway = freshServer()
    const install = gateway.plugins.install.bind(gateway.plugins)
    gateway.plugins.install = async req => {
      await new Promise(resolve => setTimeout(resolve, 100_000))
      return install(req)
    }
    const running = start(gateway)
    await vi.advanceTimersByTimeAsync(99_999)
    expect(running.settled).toBeNull()

    await vi.advanceTimersByTimeAsync(1)

    expect(running.settled).toMatchObject({ kind: 'done' })
    expect(gateway.plugins.installs).toHaveLength(1)
  })

  it('ignores what the abandoned request says when it answers later', async () => {
    const gateway = freshServer()
    gateway.plugins.install = async () => {
      await new Promise(resolve => setTimeout(resolve, 120_000))
      throw new GatewayError('unknown', 'Hermes words this its own way.', { code: 'scan_blocked', status: 400 })
    }
    const running = start(gateway)
    await vi.advanceTimersByTimeAsync(61_000)
    gateway.plugins.rows = [row('enabled')]

    await vi.advanceTimersByTimeAsync(10_000)
    expect(running.settled).toMatchObject({ kind: 'done' })
    await vi.advanceTimersByTimeAsync(60_000)

    expect(lastManualOutcome(connection.id)).toBeNull()
    expect(flag()).toBeUndefined()
  })

  it('fails with the lost connection when the install time has passed and nothing showed up', async () => {
    const gateway = hungInstall()
    const running = start(gateway)

    await vi.advanceTimersByTimeAsync(PLUGIN_INSTALL_TIMEOUT_MS - 1)
    expect(running.settled).toBeNull()
    await vi.advanceTimersByTimeAsync(1)

    expect(running.settled).toEqual({ kind: 'failed', step: 'install', message: LOST })
    const result = await running.finish()
    expect(result.last).toEqual({ install: 'failed' })
    expect(flag()).toBe(COMMIT)
  })

  it('asks to sign in again when the server stops accepting the sign-in while the run looks', async () => {
    const gateway = hungInstall()
    let reads = 0
    gateway.ergates.setHealth(() => {
      reads += 1
      return reads === 1 ? { state: 'absent' } : new GatewayError('unauthorized', 'Sign-in required.')
    })

    const result = await run(gateway)

    expect(result.outcome).toEqual({ kind: 'sign_in' })
    expect(result.last).toEqual({ install: 'failed' })
  })
})

describe('runSetup: the code that answers', () => {
  const OLD_CODE = 'a'.repeat(40)
  const OTHER = 'e'.repeat(40)

  it.each<[string, ErgatesHealth]>([
    ['older than the files on the server', healthAt(COMMIT, OLD_CODE)],
    ['from before it said which commit it runs, over the files of this build', healthAt(COMMIT, 'unreported')]
  ])('asks for a restart, without running the setup, when the plugin answers with code %s', async (_title, health) => {
    const gateway = serverListing('enabled')
    gateway.ergates.setHealth({ state: 'answered', health })

    const result = await run(gateway)

    expect(result.outcome).toEqual({ kind: 'restart' })
    expect(result.last).toEqual({ install: 'skipped', enable: 'skipped', start: 'pending' })
    expect(gateway.ergates.setupCalls).toBe(0)
    expect(flag()).toBe(COMMIT)
  })

  it('points the pending setup at the commit the files name, so the setup that follows the restart runs on the new code', async () => {
    const gateway = serverListing('enabled')
    gateway.ergates.setHealth({ state: 'answered', health: healthAt(OTHER, OLD_CODE) })
    const update = { target: OTHER, previous: OLD_CODE, previousSchema: 1 }
    useDeviceStore.getState().updateConnection(connection.id, { pluginUpdate: update })

    const result = await run(gateway)
    const pending = useDeviceStore.getState().connections[0]
    const onOldCode = await finishPendingSetup(gateway, pending, readyCheck(healthAt(OTHER, OLD_CODE)))

    expect(result.outcome).toEqual({ kind: 'restart' })
    expect(onOldCode).toEqual({ kind: 'waiting' })
    expect(gateway.ergates.setupCalls).toBe(0)
    expect(flag()).toBe(OTHER)
    expect(useDeviceStore.getState().connections[0].pluginUpdate).toEqual(update)

    const afterRestart = await finishPendingSetup(gateway, useDeviceStore.getState().connections[0], readyCheck(healthAt(OTHER)))

    expect(afterRestart).toEqual({ kind: 'done', report: FAKE_SETUP })
    expect(gateway.ergates.setupCalls).toBe(1)
    expect(flag()).toBeUndefined()
    expect(useDeviceStore.getState().connections[0].pluginUpdate).toBeUndefined()
  })

  it('does not ask for a restart for a plugin that cannot read its own record', async () => {
    const gateway = serverListing('enabled')
    gateway.ergates.setHealth({ state: 'answered', health: healthAt(COMMIT, null) })

    const result = await run(gateway)

    expect(result.outcome).toMatchObject({ kind: 'done' })
  })

  it('points the pending setup at the commit that answers, so a setup that fails finishes later on that code', async () => {
    const gateway = serverListing('disabled')
    gateway.ergates.setHealth(mountsWhenEnabled(gateway, { state: 'answered', health: healthAt(OTHER) }))
    gateway.ergates.fail('setup', new GatewayError('unauthorized', 'Sign-in required.', { status: 401 }))

    const result = await run(gateway)

    expect(result.outcome).toEqual({ kind: 'sign_in' })
    expect(result.last).toMatchObject({ install: 'skipped', enable: 'done', start: 'done', setup: 'failed' })
    expect(flag()).toBe(OTHER)
    const pending = useDeviceStore.getState().connections[0]
    await expect(finishPendingSetup(gateway, pending, readyCheck(healthAt(OTHER)))).resolves.toEqual({ kind: 'done', report: FAKE_SETUP })
    expect(gateway.ergates.setupCalls).toBe(2)
    expect(flag()).toBeUndefined()
  })

  it('points it at the commit of a plugin it finds running before it does anything else', async () => {
    const gateway = serverListing('enabled')
    gateway.ergates.setHealth({ state: 'answered', health: healthAt(OTHER) })
    gateway.ergates.fail('setup', new GatewayError('unknown', 'The request could not be completed.', { status: 500 }))

    const result = await run(gateway)

    expect(result.outcome).toMatchObject({ kind: 'failed', step: 'setup' })
    expect(flag()).toBe(OTHER)
  })

  it.each<[string, ErgatesHealth]>([
    ['no commit it reports', healthAt(OTHER, 'unreported')],
    ['a commit it could not read', healthAt(OTHER, null)],
    ['a commit that is not a full hash', healthAt('main', 'main')],
    ['a plugin that says nothing about its install', { ...FAKE_PLUGIN_HEALTH, install: undefined }]
  ])('keeps the build\'s commit in the pending setup for %s', async (_title, health) => {
    const gateway = serverListing('enabled')
    gateway.ergates.setHealth({ state: 'answered', health })
    gateway.ergates.fail('setup', new GatewayError('unknown', 'The request could not be completed.', { status: 500 }))

    await run(gateway)

    expect(flag()).toBe(COMMIT)
  })

  it('does not clear a pending setup that changed while the plugin\'s setup ran', async () => {
    const gateway = freshServer()
    const newer = 'f'.repeat(40)
    gateway.ergates.setup = async () => {
      markPendingSetup(connection.id, newer)
      return FAKE_SETUP
    }

    const result = await run(gateway)

    expect(result.outcome).toMatchObject({ kind: 'done' })
    expect(flag()).toBe(newer)
  })

  it('clears the update the app started, with the pending setup, when the setup of its target ran', async () => {
    const gateway = freshServer()
    const update = { target: COMMIT, previous: OLD_CODE, previousSchema: 1 }
    useDeviceStore.getState().updateConnection(connection.id, { pluginUpdate: update })

    await run(gateway)

    expect(useDeviceStore.getState().connections[0].pluginUpdate).toBeUndefined()
    expect(flag()).toBeUndefined()
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
    expect(runningKind(connection.id)).toBe('setup')
    expect(runningKind('c-2')).toBeNull()
    gateway.plugins.rows = [row('enabled')]
    await running.finish()
    expect(isSetupRunning(connection.id)).toBe(false)
    expect(runningKind(connection.id)).toBeNull()
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

    const during = await finishPendingSetup(gateway, pending, readyCheck())

    expect(during).toEqual({ kind: 'waiting' })
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

    const report = await finishPendingSetup(gateway, pending, readyCheck())

    expect(report).toEqual({ kind: 'done', report: FAKE_SETUP })
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
  it.each<[string, (gateway: FakeGateway) => void, SetupStep, string | undefined]>([
    ['the first health read', gateway => gateway.ergates.fail('health', new GatewayError('unauthorized', 'Sign-in required.')), 'install', undefined],
    ['the plugin list', gateway => gateway.plugins.fail('hub', new GatewayError('unauthorized', 'Sign-in required.')), 'install', COMMIT],
    ['the install', gateway => gateway.plugins.nextInstall(new GatewayError('unauthorized', 'Sign-in required.', { status: 401 })), 'install', COMMIT],
    ['the enable', gateway => gateway.plugins.fail('enable', new GatewayError('unauthorized', 'Sign-in required.', { status: 401 })), 'enable', COMMIT]
  ])('asks to sign in again when %s answers 401', async (_where, scripted, step, pending) => {
    const gateway = step === 'enable' ? serverListing('disabled') : freshServer()
    scripted(gateway)

    const result = await run(gateway)

    expect(result.outcome).toEqual({ kind: 'sign_in' })
    expect(result.last[step]).toBe('failed')
    expect(flag()).toBe(pending)
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
    const report = await finishPendingSetup(gateway, pending, readyCheck())

    expect(report).toEqual({ kind: 'done', report: FAKE_SETUP })
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

describe('joinSetup: joining a run that is going, and never starting one', () => {
  it('joins the setup that is going, is told where it is at once, and settles with its outcome', async () => {
    const gateway = freshServer()
    gateway.plugins.fail('install', networkError())
    const first = start(gateway)
    await vi.advanceTimersByTimeAsync(7_000)

    const joined: Transition[] = []
    const second = joinSetup(connection.id, (step, status) => joined.push([step, status]))

    expect(joined).toEqual([['install', 'active']])
    gateway.plugins.rows = [row('enabled')]
    const result = await first.finish()
    await expect(second).resolves.toEqual(result.outcome)
    expect(joined.at(-1)).toEqual(['setup', 'done'])
    expect(gateway.plugins.installs).toHaveLength(1)
  })

  it('answers null and touches nothing when no run is going', () => {
    const gateway = freshServer()
    const reported: Transition[] = []

    expect(joinSetup(connection.id, (step, status) => reported.push([step, status]))).toBeNull()

    expect(runningKind(connection.id)).toBeNull()
    expect(gateway.plugins.installs).toEqual([])
    expect(healthCalls(gateway)).toBe(0)
    expect(reported).toEqual([])
  })

  it('answers null for a run that has already ended, so a screen that comes too late starts nothing', async () => {
    const gateway = freshServer()
    await run(gateway)
    const installs = gateway.plugins.installs.length

    expect(joinSetup(connection.id, () => undefined)).toBeNull()

    expect(runningKind(connection.id)).toBeNull()
    expect(gateway.plugins.installs).toHaveLength(installs)
  })

  it('does not join the setup of another connection', async () => {
    const gateway = freshServer()
    gateway.plugins.fail('install', networkError())
    const first = start(gateway)
    await vi.advanceTimersByTimeAsync(1_000)

    expect(joinSetup('c-9', () => undefined)).toBeNull()
    gateway.plugins.rows = [row('enabled')]
    await first.finish()
  })
})
