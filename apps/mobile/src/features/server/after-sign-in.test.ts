/**
 * Where the app goes once the user is signed in to a server: the setup
 * screens when the plugin needs something from the user, Home otherwise.
 * The tests drive the real check with FakeGateway.
 */
import { describe, expect, it } from 'vitest'

import { GatewayError } from '@/gateway/errors'
import type { HermesPluginRow, PluginProbe } from '@/gateway/types'
import { FAKE_PLUGIN_HEALTH } from '@test/fake-gateway/fake-ergates'
import { FakeGateway } from '@test/fake-gateway/fake-gateway'

import { afterSignIn, routeAfterCheck } from './after-sign-in'
import type { BuildRecord } from './build-record'
import type { ServerCheck } from './server-check'

function buildRecord(commit: string | null = 'b'.repeat(40)): BuildRecord {
  return { requiredPlugin: { version: '0.2.0', apiLevel: 1, commit }, hermesRange: { oldest: '0.21.6', newestMinor: '0.21' } }
}

function serverWith(health: PluginProbe | Error, rows: HermesPluginRow[] = []): FakeGateway {
  const gateway = new FakeGateway()
  gateway.ergates.setHealth(health)
  gateway.setHermesVersion('0.21.6')
  gateway.plugins.rows = rows
  return gateway
}

const answered: PluginProbe = { state: 'answered', health: FAKE_PLUGIN_HEALTH }

describe('afterSignIn', () => {
  it('goes Home when the plugin is ready', async () => {
    await expect(afterSignIn(serverWith(answered), buildRecord())).resolves.toBe('/')
  })

  it('opens the setup screen when the plugin is missing', async () => {
    await expect(afterSignIn(serverWith({ state: 'absent' }), buildRecord())).resolves.toBe('/server')
  })

  it('opens the setup screen when the plugin is on the server but turned off', async () => {
    const rows: HermesPluginRow[] = [{ name: 'ergates', version: '0.2.0', runtime_status: 'disabled' }]

    await expect(afterSignIn(serverWith({ state: 'absent' }, rows), buildRecord())).resolves.toBe('/server')
  })

  it('opens the Finish screen when Hermes has not loaded the plugin', async () => {
    await expect(afterSignIn(serverWith({ state: 'not_loaded' }), buildRecord())).resolves.toBe('/server/finish')
  })

  it('opens the Finish screen when the plugin is older than this app needs', async () => {
    const older = { state: 'answered', health: { ok: true, plugin_version: '0.1.0', schema_version: 1 } } satisfies PluginProbe

    await expect(afterSignIn(serverWith(older), buildRecord())).resolves.toBe('/server/finish')
  })

  it('goes Home when the plugin is newer than this app', async () => {
    const newer = { state: 'answered', health: { ...FAKE_PLUGIN_HEALTH, min_api_level: 2, api_level: 2 } } satisfies PluginProbe

    await expect(afterSignIn(serverWith(newer), buildRecord())).resolves.toBe('/')
  })

  it('goes Home when the health read fails on the network, because nothing is known about the plugin', async () => {
    await expect(afterSignIn(serverWith(new GatewayError('network', 'Could not reach the gateway.')), buildRecord())).resolves.toBe('/')
  })

  it('goes Home when the server answers 401 right after the sign-in, where Home takes the sign-in over', async () => {
    await expect(afterSignIn(serverWith(new GatewayError('unauthorized', 'Sign-in required.', { status: 401 })), buildRecord())).resolves.toBe('/')
  })

  it('goes Home when the health read throws something that is not a gateway error, which the check counts as not knowing', async () => {
    await expect(afterSignIn(serverWith(new TypeError('boom')), buildRecord())).resolves.toBe('/')
  })

  it('opens the Finish screen for a plugin the server lists as enabled but does not serve yet', async () => {
    const rows: HermesPluginRow[] = [{ name: 'ergates', version: '0.2.0', runtime_status: 'enabled' }]

    await expect(afterSignIn(serverWith({ state: 'absent' }, rows), buildRecord())).resolves.toBe('/server/finish')
  })

  it('works without a build record', async () => {
    await expect(afterSignIn(serverWith({ state: 'absent' }), null)).resolves.toBe('/server')
  })
})

describe('routeAfterCheck', () => {
  it.each<[string, ServerCheck, string]>([
    ['ready', { kind: 'ready', health: FAKE_PLUGIN_HEALTH }, '/'],
    ['missing, one tap', { kind: 'missing', hermesVersion: '0.21.6', oneTap: true, reason: null }, '/server'],
    ['missing, by hand', { kind: 'missing', hermesVersion: '0.20.0', oneTap: false, reason: 'too_old' }, '/server'],
    ['disabled', { kind: 'disabled', hermesVersion: '0.21.6' }, '/server'],
    ['not loaded', { kind: 'not_loaded', hermesVersion: '0.21.6' }, '/server/finish'],
    ['outdated', { kind: 'outdated', health: FAKE_PLUGIN_HEALTH, installKind: 'deployment', hermesVersion: '0.21.6' }, '/server/finish'],
    ['newer than the app', { kind: 'app_outdated', health: FAKE_PLUGIN_HEALTH }, '/'],
    ['unavailable', { kind: 'unavailable', message: 'The store is not available.' }, '/'],
    ['unknown', { kind: 'unknown' }, '/']
  ])('sends a check that is %s to %s', (_title, check, route) => {
    expect(routeAfterCheck(check)).toBe(route)
  })
})
