/**
 * The pending setup is the commit of a plugin the app put on a server and has
 * not run the plugin's setup for yet. It sits on the connection, so a closed
 * app, a second screen or a later launch still finishes the setup, once.
 */
import { beforeEach, describe, expect, it } from 'vitest'

import { GatewayError } from '@/gateway/errors'
import type { ErgatesHealth } from '@/gateway/types'
import { useDeviceStore, type Connection } from '@/state/device-store'
import { FAKE_PLUGIN_HEALTH, FAKE_SETUP } from '@test/fake-gateway/fake-ergates'
import { FakeGateway } from '@test/fake-gateway/fake-gateway'

import { clearPendingSetup, finishPendingSetup, markPendingSetup } from './pending-setup'
import type { ServerCheck } from './server-check'

const COMMIT = 'd'.repeat(40)

const first: Connection = { id: 'c-1', label: 'Home server', baseUrl: 'http://100.64.0.1:9119', authMode: 'token', primary: true, createdAt: 1 }
const second: Connection = { id: 'c-2', label: 'Office server', baseUrl: 'http://100.64.0.2:9119', authMode: 'password', primary: false, createdAt: 2 }

const OLD_COMMIT = 'a'.repeat(40)

/** A ready check whose plugin answers with the code of `loaded` (a git install), or with the install `install` says. */
function readyWith(install: ErgatesHealth['install']): ServerCheck {
  return { kind: 'ready', health: { ...FAKE_PLUGIN_HEALTH, install }, update: null, hermesVersion: null }
}

/** The plugin the pending setup waits for: installed from COMMIT and running it. */
const ready = readyWith({ kind: 'git install', commit: COMMIT, loaded_commit: COMMIT, catalog_name: null })

function stored(id: string): Connection {
  const found = useDeviceStore.getState().connections.find(connection => connection.id === id)
  if (!found) {
    throw new Error(`no connection ${id}`)
  }
  return found
}

beforeEach(() => {
  useDeviceStore.setState({ connections: [{ ...first }, { ...second }] })
})

describe('markPendingSetup and clearPendingSetup', () => {
  it('keeps the commit on the one connection and removes it again', () => {
    markPendingSetup('c-1', COMMIT)

    expect(stored('c-1').pendingPluginSetup).toBe(COMMIT)
    expect(stored('c-2').pendingPluginSetup).toBeUndefined()

    clearPendingSetup('c-1')

    expect(stored('c-1')).toEqual(first)
  })
})

describe('finishPendingSetup', () => {
  it('runs the setup once and clears the flag when the plugin is ready', async () => {
    const gateway = new FakeGateway()
    markPendingSetup('c-1', COMMIT)

    const report = await finishPendingSetup(gateway, stored('c-1'), ready)

    expect(report).toEqual(FAKE_SETUP)
    expect(gateway.ergates.setupCalls).toBe(1)
    expect(stored('c-1').pendingPluginSetup).toBeUndefined()
  })

  it('does nothing without a pending setup', async () => {
    const gateway = new FakeGateway()

    const report = await finishPendingSetup(gateway, stored('c-1'), ready)

    expect(report).toBeNull()
    expect(gateway.ergates.setupCalls).toBe(0)
  })

  it.each<[string, ServerCheck]>([
    ['missing', { kind: 'missing', hermesVersion: '0.21.6', oneTap: true, reason: null }],
    ['disabled', { kind: 'disabled', hermesVersion: '0.21.6' }],
    ['not loaded', { kind: 'not_loaded', hermesVersion: '0.21.6' }],
    ['waiting for a restart', { kind: 'restart_needed', health: FAKE_PLUGIN_HEALTH, hermesVersion: '0.21.6' }],
    ['outdated', { kind: 'outdated', health: FAKE_PLUGIN_HEALTH, installKind: 'git install', update: null, hermesVersion: '0.21.6' }],
    ['unknown', { kind: 'unknown' }]
  ])('keeps the flag and waits while the plugin is %s', async (_title, check) => {
    const gateway = new FakeGateway()
    markPendingSetup('c-1', COMMIT)

    const report = await finishPendingSetup(gateway, stored('c-1'), check)

    expect(report).toBeNull()
    expect(gateway.ergates.setupCalls).toBe(0)
    expect(stored('c-1').pendingPluginSetup).toBe(COMMIT)
  })

  it.each([
    ['sign-in is required', new GatewayError('unauthorized', 'Sign-in required.', { status: 401 })],
    ['the server fails', new GatewayError('unknown', 'The request could not be completed.', { status: 500 })]
  ])('keeps the flag and rejects when %s', async (_title, error) => {
    const gateway = new FakeGateway()
    gateway.ergates.fail('setup', error)
    markPendingSetup('c-1', COMMIT)

    await expect(finishPendingSetup(gateway, stored('c-1'), ready)).rejects.toBe(error)

    expect(stored('c-1').pendingPluginSetup).toBe(COMMIT)
  })

  it('reads the flag from the device store, not from the connection it is handed', async () => {
    const gateway = new FakeGateway()
    const stale = { ...first, pendingPluginSetup: COMMIT }

    const report = await finishPendingSetup(gateway, stale, ready)

    expect(report).toBeNull()
    expect(gateway.ergates.setupCalls).toBe(0)
  })

  it('runs the setup for a flag the store holds although the connection it is handed has none', async () => {
    const gateway = new FakeGateway()
    markPendingSetup('c-1', COMMIT)

    const report = await finishPendingSetup(gateway, first, ready)

    expect(report).toEqual(FAKE_SETUP)
    expect(gateway.ergates.setupCalls).toBe(1)
  })

  it('runs the setup once when two callers finish it at the same time, and gives both the report', async () => {
    const gateway = new FakeGateway()
    markPendingSetup('c-1', COMMIT)

    const reports = await Promise.all([finishPendingSetup(gateway, stored('c-1'), ready), finishPendingSetup(gateway, stored('c-1'), ready)])

    expect(reports).toEqual([FAKE_SETUP, FAKE_SETUP])
    expect(gateway.ergates.setupCalls).toBe(1)
    expect(stored('c-1').pendingPluginSetup).toBeUndefined()
  })

  it('gives both callers the failure of the one setup, and lets the next caller try again', async () => {
    const gateway = new FakeGateway()
    const error = new GatewayError('unknown', 'The request could not be completed.', { status: 500 })
    gateway.ergates.fail('setup', error)
    markPendingSetup('c-1', COMMIT)

    const attempts = await Promise.allSettled([finishPendingSetup(gateway, stored('c-1'), ready), finishPendingSetup(gateway, stored('c-1'), ready)])

    expect(attempts).toEqual([
      { status: 'rejected', reason: error },
      { status: 'rejected', reason: error }
    ])
    expect(gateway.ergates.setupCalls).toBe(1)
    expect(stored('c-1').pendingPluginSetup).toBe(COMMIT)
    await expect(finishPendingSetup(gateway, stored('c-1'), ready)).resolves.toEqual(FAKE_SETUP)
    expect(gateway.ergates.setupCalls).toBe(2)
  })

  it('clears the update the app started when the setup of its target finishes', async () => {
    const gateway = new FakeGateway()
    markPendingSetup('c-1', COMMIT)
    useDeviceStore.getState().updateConnection('c-1', { pluginUpdate: { target: COMMIT, previous: OLD_COMMIT, previousSchema: 1 } })

    await finishPendingSetup(gateway, stored('c-1'), ready)

    expect(stored('c-1')).toEqual(first)
  })

  it('keeps the update when the setup fails', async () => {
    const gateway = new FakeGateway()
    gateway.ergates.fail('setup', new GatewayError('unknown', 'The request could not be completed.', { status: 500 }))
    markPendingSetup('c-1', COMMIT)
    const update = { target: COMMIT, previous: OLD_COMMIT, previousSchema: 1 }
    useDeviceStore.getState().updateConnection('c-1', { pluginUpdate: update })

    await expect(finishPendingSetup(gateway, stored('c-1'), ready)).rejects.toThrow()

    expect(stored('c-1').pluginUpdate).toEqual(update)
  })

  describe('when the connection changes while the setup runs', () => {
    const NEWER = 'e'.repeat(40)
    const started = { target: COMMIT, previous: OLD_COMMIT, previousSchema: 1 }
    const next = { target: NEWER, previous: COMMIT, previousSchema: 2 }

    /** A gateway whose setup answers when `release` is called. */
    function slowSetup(): { gateway: FakeGateway; release: () => void } {
      const gateway = new FakeGateway()
      let release: () => void = () => undefined
      const gate = new Promise<void>(resolve => {
        release = resolve
      })
      gateway.ergates.setup = async () => {
        await gate
        return FAKE_SETUP
      }
      return { gateway, release }
    }

    it('keeps an update that was started meanwhile, with its pending setup', async () => {
      const { gateway, release } = slowSetup()
      markPendingSetup('c-1', COMMIT)
      useDeviceStore.getState().updateConnection('c-1', { pluginUpdate: started })
      const finishing = finishPendingSetup(gateway, stored('c-1'), ready)

      markPendingSetup('c-1', NEWER)
      useDeviceStore.getState().updateConnection('c-1', { pluginUpdate: next })
      release()

      await expect(finishing).resolves.toEqual(FAKE_SETUP)
      expect(stored('c-1').pendingPluginSetup).toBe(NEWER)
      expect(stored('c-1').pluginUpdate).toEqual(next)
    })

    it('clears the pending setup it ran for and keeps an update that changed', async () => {
      const { gateway, release } = slowSetup()
      markPendingSetup('c-1', COMMIT)
      useDeviceStore.getState().updateConnection('c-1', { pluginUpdate: started })
      const finishing = finishPendingSetup(gateway, stored('c-1'), ready)

      useDeviceStore.getState().updateConnection('c-1', { pluginUpdate: next })
      release()

      await finishing
      expect(stored('c-1').pendingPluginSetup).toBeUndefined()
      expect(stored('c-1').pluginUpdate).toEqual(next)
    })

    it('clears the update it saw when only the pending setup was marked again with the same commit', async () => {
      const { gateway, release } = slowSetup()
      markPendingSetup('c-1', COMMIT)
      useDeviceStore.getState().updateConnection('c-1', { pluginUpdate: started })
      const finishing = finishPendingSetup(gateway, stored('c-1'), ready)

      markPendingSetup('c-1', COMMIT)
      release()

      await finishing
      expect(stored('c-1')).toEqual(first)
    })

    it('leaves a connection that was removed alone', async () => {
      const { gateway, release } = slowSetup()
      markPendingSetup('c-1', COMMIT)
      const finishing = finishPendingSetup(gateway, stored('c-1'), ready)

      useDeviceStore.setState({ connections: [{ ...second }] })
      release()

      await expect(finishing).resolves.toEqual(FAKE_SETUP)
      expect(stored('c-2')).toEqual(second)
    })
  })

  it('does not share the setup between connections', async () => {
    const gateway = new FakeGateway()
    markPendingSetup('c-1', COMMIT)
    markPendingSetup('c-2', COMMIT)

    await Promise.all([finishPendingSetup(gateway, stored('c-1'), ready), finishPendingSetup(gateway, stored('c-2'), ready)])

    expect(gateway.ergates.setupCalls).toBe(2)
  })

  it('leaves another connection\'s flag alone', async () => {
    const gateway = new FakeGateway()
    markPendingSetup('c-1', COMMIT)
    markPendingSetup('c-2', COMMIT)

    await finishPendingSetup(gateway, stored('c-1'), ready)

    expect(stored('c-2').pendingPluginSetup).toBe(COMMIT)
  })
})

describe('finishPendingSetup: the code that answers', () => {
  it.each<[string, ErgatesHealth['install']]>([
    ['an older commit', { kind: 'git install', commit: COMMIT, loaded_commit: OLD_COMMIT, catalog_name: null }],
    ['a commit it does not report', { kind: 'git install', commit: COMMIT, catalog_name: null }],
    ['a commit it could not read', { kind: 'git install', commit: COMMIT, loaded_commit: null, catalog_name: null }]
  ])('keeps the flag and waits while the plugin of a git install runs %s', async (_title, install) => {
    const gateway = new FakeGateway()
    markPendingSetup('c-1', COMMIT)

    const report = await finishPendingSetup(gateway, stored('c-1'), readyWith(install))

    expect(report).toBeNull()
    expect(gateway.ergates.setupCalls).toBe(0)
    expect(stored('c-1').pendingPluginSetup).toBe(COMMIT)
  })

  it('runs the setup once the plugin runs the commit that is pending', async () => {
    const gateway = new FakeGateway()
    markPendingSetup('c-1', COMMIT)
    const oldCode = readyWith({ kind: 'git install', commit: COMMIT, loaded_commit: OLD_COMMIT, catalog_name: null })

    await finishPendingSetup(gateway, stored('c-1'), oldCode)
    expect(gateway.ergates.setupCalls).toBe(0)
    const report = await finishPendingSetup(gateway, stored('c-1'), ready)

    expect(report).toEqual(FAKE_SETUP)
    expect(gateway.ergates.setupCalls).toBe(1)
    expect(stored('c-1').pendingPluginSetup).toBeUndefined()
  })

  it.each<[string, ErgatesHealth['install']]>([
    ['a deployment', { kind: 'deployment', commit: null, loaded_commit: null, catalog_name: null }],
    ['a manual copy', { kind: 'manual copy', commit: null, loaded_commit: null, catalog_name: null }],
    ['a plugin that says nothing about its install', undefined]
  ])('runs the setup for %s whatever commit is pending, since no commit says which code it runs', async (_title, install) => {
    const gateway = new FakeGateway()
    markPendingSetup('c-1', COMMIT)

    const report = await finishPendingSetup(gateway, stored('c-1'), readyWith(install))

    expect(report).toEqual(FAKE_SETUP)
    expect(gateway.ergates.setupCalls).toBe(1)
  })
})
