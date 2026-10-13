/**
 * Where the app goes once the user is signed in to a server: the setup
 * screens when the plugin needs something from the user, Home otherwise.
 * The tests drive the real check with FakeGateway.
 */
import { describe, expect, it } from 'vitest'

import { GatewayError } from '@/gateway/errors'
import type { HermesPluginRow, PluginProbe } from '@/gateway/types'
import type { Connection } from '@/state/device-store'
import { FAKE_PLUGIN_HEALTH } from '@test/fake-gateway/fake-ergates'
import { FakeGateway } from '@test/fake-gateway/fake-gateway'

import { afterSignIn, routeAfterCheck } from './after-sign-in'
import type { BuildRecord } from './build-record'
import type { UpdateOffer } from './plugin-version'
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

const offer: UpdateOffer = { from: '0.1.0', to: '0.2.0', commit: 'b'.repeat(40), previous: 'a'.repeat(40), previousSchema: 1 }
const connection: Connection = { id: 'c1', label: 'A', baseUrl: 'http://a.example', authMode: 'token', primary: true, createdAt: 1 }

describe('afterSignIn', () => {
  it('goes Home when the plugin is ready', async () => {
    await expect(afterSignIn(serverWith(answered), buildRecord(), connection)).resolves.toBe('/')
  })

  it('opens the setup screen when the plugin is missing', async () => {
    await expect(afterSignIn(serverWith({ state: 'absent' }), buildRecord(), connection)).resolves.toBe('/server')
  })

  it('opens the setup screen when the plugin is on the server but turned off', async () => {
    const rows: HermesPluginRow[] = [{ name: 'ergates', version: '0.2.0', runtime_status: 'disabled' }]

    await expect(afterSignIn(serverWith({ state: 'absent' }, rows), buildRecord(), connection)).resolves.toBe('/server')
  })

  it('opens the Finish screen when Hermes has not loaded the plugin', async () => {
    const rows: HermesPluginRow[] = [{ name: 'ergates', version: '0.2.0', runtime_status: 'enabled' }]

    await expect(afterSignIn(serverWith({ state: 'not_loaded' }, rows), buildRecord(), connection)).resolves.toBe('/server/finish')
  })

  it('opens the setup screen when Hermes found no routes and does not list the plugin at all', async () => {
    await expect(afterSignIn(serverWith({ state: 'not_loaded' }), buildRecord(), connection)).resolves.toBe('/server')
  })

  it('opens the Finish screen when the plugin is older than this app needs', async () => {
    const older = { state: 'answered', health: { ok: true, plugin_version: '0.1.0', schema_version: 1 } } satisfies PluginProbe

    await expect(afterSignIn(serverWith(older), buildRecord(), connection)).resolves.toBe('/server/finish')
  })

  it('goes Home when the plugin is newer than this app', async () => {
    const newer = { state: 'answered', health: { ...FAKE_PLUGIN_HEALTH, min_api_level: 2, api_level: 2 } } satisfies PluginProbe

    await expect(afterSignIn(serverWith(newer), buildRecord(), connection)).resolves.toBe('/')
  })

  it('goes Home when the health read fails on the network, because nothing is known about the plugin', async () => {
    await expect(afterSignIn(serverWith(new GatewayError('network', 'Could not reach the gateway.')), buildRecord(), connection)).resolves.toBe('/')
  })

  it('goes Home when the server answers 401 right after the sign-in, where Home takes the sign-in over', async () => {
    await expect(afterSignIn(serverWith(new GatewayError('unauthorized', 'Sign-in required.', { status: 401 })), buildRecord(), connection)).resolves.toBe('/')
  })

  it('goes Home when the health read throws something that is not a gateway error, which the check counts as not knowing', async () => {
    await expect(afterSignIn(serverWith(new TypeError('boom')), buildRecord(), connection)).resolves.toBe('/')
  })

  it('opens the Finish screen for a plugin the server lists as enabled but does not serve yet', async () => {
    const rows: HermesPluginRow[] = [{ name: 'ergates', version: '0.2.0', runtime_status: 'enabled' }]

    await expect(afterSignIn(serverWith({ state: 'absent' }, rows), buildRecord(), connection)).resolves.toBe('/server/finish')
  })

  it('works without a build record', async () => {
    await expect(afterSignIn(serverWith({ state: 'absent' }), null, connection)).resolves.toBe('/server')
  })
})

/** The plugin of the build record (0.2.0, commit b...) is newer than this one, so an update is offered. */
const olderPlugin: PluginProbe = { state: 'answered', health: { ...FAKE_PLUGIN_HEALTH, plugin_version: '0.1.0' } }

/** An older plugin that does not know this app's API level, so it needs the update. */
const unusablePlugin: PluginProbe = { state: 'answered', health: { ...FAKE_PLUGIN_HEALTH, plugin_version: '0.1.0', api_level: 0 } }

describe('afterSignIn: an update is offered', () => {
  it('opens Update ready for a working plugin the user was not asked about', async () => {
    await expect(afterSignIn(serverWith(olderPlugin), buildRecord(), connection)).resolves.toBe('/server/update')
  })

  it('opens Update ready for a plugin that needs the update too', async () => {
    await expect(afterSignIn(serverWith(unusablePlugin), buildRecord(), connection)).resolves.toBe('/server/update')
  })

  it('opens Update ready again for a newer update than the one the user was asked about', async () => {
    const asked: Connection = { ...connection, askedUpdateFor: 'c'.repeat(40) }

    await expect(afterSignIn(serverWith(olderPlugin), buildRecord(), asked)).resolves.toBe('/server/update')
  })

  it('goes Home once the user was asked about this update, where the line offers it', async () => {
    const asked: Connection = { ...connection, askedUpdateFor: 'b'.repeat(40) }

    await expect(afterSignIn(serverWith(olderPlugin), buildRecord(), asked)).resolves.toBe('/')
  })

  it('goes Home when the update runs without asking, where Home runs it on its own check', async () => {
    const learned: Connection = { ...connection, pluginRemountsFrom: '0.21.6' }

    await expect(afterSignIn(serverWith(olderPlugin), buildRecord(), learned)).resolves.toBe('/')
  })

  it('goes Home with the switch off, whichever plugin it is, so no screen opens by itself', async () => {
    const off: Connection = { ...connection, autoUpdatePlugin: false }

    await expect(afterSignIn(serverWith(olderPlugin), buildRecord(), off)).resolves.toBe('/')
    await expect(afterSignIn(serverWith(unusablePlugin), buildRecord(), off)).resolves.toBe('/')
  })

  it('goes Home with the switch off even for a Hermes the connection learned about', async () => {
    const off: Connection = { ...connection, autoUpdatePlugin: false, pluginRemountsFrom: '0.21.6' }

    await expect(afterSignIn(serverWith(olderPlugin), buildRecord(), off)).resolves.toBe('/')
  })

  it('still opens the setup screen for a missing plugin, which has nothing to update', async () => {
    await expect(afterSignIn(serverWith({ state: 'absent' }), buildRecord(), connection)).resolves.toBe('/server')
  })
})

describe('routeAfterCheck', () => {
  it.each<[string, ServerCheck, string]>([
    ['ready', { kind: 'ready', health: FAKE_PLUGIN_HEALTH, update: null, hermesVersion: null }, '/'],
    ['missing, one tap', { kind: 'missing', hermesVersion: '0.21.6', oneTap: true, reason: null }, '/server'],
    ['missing, by hand', { kind: 'missing', hermesVersion: '0.20.0', oneTap: false, reason: 'too_old' }, '/server'],
    ['disabled', { kind: 'disabled', hermesVersion: '0.21.6' }, '/server'],
    ['not loaded', { kind: 'not_loaded', hermesVersion: '0.21.6' }, '/server/finish'],
    ['waiting for a restart', { kind: 'restart_needed', health: FAKE_PLUGIN_HEALTH, hermesVersion: '0.21.6' }, '/server/finish'],
    ['outdated, with nothing the app can update', { kind: 'outdated', health: FAKE_PLUGIN_HEALTH, installKind: 'deployment', update: null, hermesVersion: '0.21.6' }, '/server/finish'],
    ['outdated, with an update the app can make', { kind: 'outdated', health: FAKE_PLUGIN_HEALTH, installKind: 'git install', update: offer, hermesVersion: '0.21.6' }, '/'],
    ['ready, with an update', { kind: 'ready', health: FAKE_PLUGIN_HEALTH, update: offer, hermesVersion: '0.21.6' }, '/'],
    ['newer than the app', { kind: 'app_outdated', health: FAKE_PLUGIN_HEALTH }, '/'],
    ['unavailable', { kind: 'unavailable', message: 'The store is not available.' }, '/'],
    ['unknown', { kind: 'unknown' }, '/']
  ])('sends a check that is %s to %s', (_title, check, route) => {
    expect(routeAfterCheck(check)).toBe(route)
  })
})
