/**
 * An update that runs without asking: it records that the target was handled
 * before anything changes on the server, then leaves on the connection what
 * the run learned. The tests drive the real run with FakeGateway.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { GatewayError } from '@/gateway/errors'
import { useDeviceStore, type Connection } from '@/state/device-store'
import { FAKE_PLUGIN_COMMIT, FAKE_SETUP } from '@test/fake-gateway/fake-ergates'
import { FakeGateway } from '@test/fake-gateway/fake-gateway'

import type { BuildRecord } from './build-record'
import type { UpdateOffer } from './plugin-version'
import { clearUpdatedNotice, updateSilently } from './silent-update'

const TARGET = 'b'.repeat(40)

const connection: Connection = { id: 'c-1', label: 'Home server', baseUrl: 'http://100.64.0.1:9119', authMode: 'token', primary: true, createdAt: 1, pluginRemountsFrom: '0.21.6' }

const build: BuildRecord = { requiredPlugin: { version: '0.3.0', apiLevel: 2, commit: TARGET }, hermesRange: { oldest: '0.21.6', newestMinor: '0.21' } }
const offer: UpdateOffer = { from: '0.2.0', to: '0.3.0', commit: TARGET, previous: FAKE_PLUGIN_COMMIT, previousSchema: 1 }

/** A server that runs the plugin at the old commit. */
function runningServer(): FakeGateway {
  const gateway = new FakeGateway()
  gateway.plugins.rows = [{ name: 'ergates', version: '0.2.0', runtime_status: 'enabled' }]
  gateway.setHermesVersion('0.21.7')
  return gateway
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

function stored(): Connection {
  const found = useDeviceStore.getState().connections.find(each => each.id === connection.id)
  if (!found) {
    throw new Error(`no connection ${connection.id}`)
  }
  return found
}

/** What the connection held each time the check was asked again. */
const rechecked: Connection[] = []
const recheck = vi.fn(async () => {
  rechecked.push(stored())
})

/** Runs the update and lets every wait elapse. */
async function update(gateway: FakeGateway) {
  const outcome = updateSilently(gateway, build, connection.id, offer, recheck)
  await vi.runAllTimersAsync()
  return outcome
}

beforeEach(() => {
  vi.useFakeTimers()
  recheck.mockClear()
  rechecked.length = 0
  useDeviceStore.setState({ connections: [{ ...connection }] })
})

afterEach(async () => {
  await vi.runAllTimersAsync()
  vi.useRealTimers()
})

describe('updateSilently', () => {
  it('records that this update was handled before anything changes on the server', async () => {
    const gateway = runningServer()
    remounting(gateway)
    const disable = gateway.plugins.disable.bind(gateway.plugins)
    const recorded: (string | undefined)[] = []
    gateway.plugins.disable = name => {
      recorded.push(stored().askedUpdateFor)
      return disable(name)
    }

    await update(gateway)

    expect(recorded).toEqual([TARGET])
  })

  it('tells the user once that the server was updated, when the new code answers', async () => {
    const gateway = runningServer()
    remounting(gateway)

    const outcome = await update(gateway)

    expect(outcome).toEqual({ kind: 'done', setup: FAKE_SETUP })
    expect(stored()).toMatchObject({ askedUpdateFor: TARGET, pluginUpdatedNotice: { from: '0.2.0', to: '0.3.0' }, pluginRemountsFrom: '0.21.6' })
  })

  it('forgets that this Hermes needs no restart when the update did need one, and says nothing was updated', async () => {
    // The server keeps answering with the old code until Hermes restarts.
    const gateway = runningServer()

    const outcome = await update(gateway)

    expect(outcome).toEqual({ kind: 'restart' })
    expect(stored().pluginRemountsFrom).toBeUndefined()
    expect(stored().pluginUpdatedNotice).toBeUndefined()
    expect(stored().askedUpdateFor).toBe(TARGET)
  })

  it('records nothing more when Hermes refuses the install, so the line offers the update instead of a new try', async () => {
    const gateway = runningServer()
    gateway.plugins.nextInstall(new GatewayError('unknown', 'Hermes words this its own way.', { code: 'scan_blocked', status: 400 }))

    const outcome = await update(gateway)

    expect(outcome.kind).toBe('manual')
    expect(stored()).toMatchObject({ askedUpdateFor: TARGET, pluginRemountsFrom: '0.21.6' })
    expect(stored().pluginUpdatedNotice).toBeUndefined()
  })

  it('records nothing more when the session ended, and leaves the sign-in to Home', async () => {
    const gateway = runningServer()
    gateway.plugins.disable = () => Promise.reject(new GatewayError('unauthorized', 'Sign-in required.', { status: 401 }))

    const outcome = await update(gateway)

    expect(outcome).toEqual({ kind: 'sign_in' })
    expect(stored()).toMatchObject({ askedUpdateFor: TARGET, pluginRemountsFrom: '0.21.6' })
    expect(stored().pluginUpdatedNotice).toBeUndefined()
  })

  it('asks the server check again once the run ended, with what the run left already on the connection', async () => {
    const gateway = runningServer()
    remounting(gateway)

    await update(gateway)

    expect(recheck).toHaveBeenCalledTimes(1)
    expect(rechecked[0]).toMatchObject({ askedUpdateFor: TARGET, pluginUpdatedNotice: { from: '0.2.0', to: '0.3.0' } })
  })

  it('asks again after a run that needed a restart, so the restart line takes over', async () => {
    await update(runningServer())

    expect(recheck).toHaveBeenCalledTimes(1)
    expect(rechecked[0].pluginRemountsFrom).toBeUndefined()
  })

  it('asks again after Hermes refused the install, so the line shows what the server says now', async () => {
    const gateway = runningServer()
    gateway.plugins.nextInstall(new GatewayError('unknown', 'Hermes words this its own way.', { code: 'scan_blocked', status: 400 }))

    await update(gateway)

    expect(recheck).toHaveBeenCalledTimes(1)
  })

  it('asks again after the session ended, so Home reads the 401 and shows its sign-in line instead of an update on a dead session', async () => {
    const gateway = runningServer()
    gateway.plugins.disable = () => Promise.reject(new GatewayError('unauthorized', 'Sign-in required.', { status: 401 }))

    await update(gateway)

    expect(recheck).toHaveBeenCalledTimes(1)
  })

  it('does not run the update for a commit this build does not carry', async () => {
    const gateway = runningServer()
    const outcome = updateSilently(gateway, build, connection.id, { ...offer, commit: 'c'.repeat(40) }, recheck)
    await vi.runAllTimersAsync()

    await expect(outcome).resolves.toEqual({ kind: 'manual', failure: 'refused', detail: null })
    expect(gateway.plugins.disabled).toEqual([])
  })
})

describe('clearUpdatedNotice', () => {
  it('clears the notice once Home has shown it', () => {
    useDeviceStore.getState().updateConnection(connection.id, { pluginUpdatedNotice: { from: '0.2.0', to: '0.3.0' } })

    clearUpdatedNotice(connection.id)

    expect(stored().pluginUpdatedNotice).toBeUndefined()
  })

  it('leaves the store alone when there is no notice, so leaving Home does not redraw everything that reads it', () => {
    const before = useDeviceStore.getState().connections

    clearUpdatedNotice(connection.id)
    clearUpdatedNotice('c-gone')

    expect(useDeviceStore.getState().connections).toBe(before)
  })
})
