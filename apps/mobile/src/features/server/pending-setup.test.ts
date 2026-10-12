/**
 * The pending setup is the commit of a plugin the app put on a server and has
 * not run the plugin's setup for yet. It sits on the connection, so a closed
 * app, a second screen or a later launch still finishes the setup, once.
 */
import { beforeEach, describe, expect, it } from 'vitest'

import { GatewayError } from '@/gateway/errors'
import { useDeviceStore, type Connection } from '@/state/device-store'
import { FAKE_PLUGIN_HEALTH, FAKE_SETUP } from '@test/fake-gateway/fake-ergates'
import { FakeGateway } from '@test/fake-gateway/fake-gateway'

import { clearPendingSetup, finishPendingSetup, markPendingSetup } from './pending-setup'
import type { ServerCheck } from './server-check'

const COMMIT = 'd'.repeat(40)

const first: Connection = { id: 'c-1', label: 'Home server', baseUrl: 'http://100.64.0.1:9119', authMode: 'token', primary: true, createdAt: 1 }
const second: Connection = { id: 'c-2', label: 'Office server', baseUrl: 'http://100.64.0.2:9119', authMode: 'password', primary: false, createdAt: 2 }

const ready: ServerCheck = { kind: 'ready', health: FAKE_PLUGIN_HEALTH }

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
    ['outdated', { kind: 'outdated', health: FAKE_PLUGIN_HEALTH, installKind: 'git install', hermesVersion: '0.21.6' }],
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

  it('leaves another connection\'s flag alone', async () => {
    const gateway = new FakeGateway()
    markPendingSetup('c-1', COMMIT)
    markPendingSetup('c-2', COMMIT)

    await finishPendingSetup(gateway, stored('c-1'), ready)

    expect(stored('c-2').pendingPluginSetup).toBe(COMMIT)
  })
})
