import { describe, expect, it, vi } from 'vitest'

import { GatewayError, mapErgatesError, mapHttpError } from '@/gateway/errors'
import type { ErgatesHealth, HermesPluginRow, PluginProbe } from '@/gateway/types'
import { FakeGateway } from '@test/fake-gateway/fake-gateway'

import type { BuildRecord } from './build-record'
import { checkServer, pluginFits } from './server-check'

const COMMIT = 'b'.repeat(40)
const APP_LEVEL = 1

function buildRecord(commit: string | null = COMMIT, apiLevel = APP_LEVEL): BuildRecord {
  return {
    requiredPlugin: { version: '0.2.0', apiLevel, commit },
    hermesRange: { oldest: '0.21.6', newestMinor: '0.21' }
  }
}

function currentHealth(overrides: Partial<ErgatesHealth> = {}): ErgatesHealth {
  return {
    ok: true,
    plugin_version: '0.2.0',
    api_level: 1,
    min_api_level: 1,
    schema_version: 1,
    store: { plugin_schema_version: 1, min_schema_version: 1, writable: true },
    install: { kind: 'git install', commit: COMMIT, catalog_name: null },
    ...overrides
  }
}

/** The body an older plugin answered before it reported its levels, its store and its install. */
const OLDER_HEALTH: ErgatesHealth = { ok: true, schema_version: 1, plugin_version: '0.2.0' }

function answered(health: ErgatesHealth): PluginProbe {
  return { state: 'answered', health }
}

function row(runtime_status: HermesPluginRow['runtime_status'], name = 'ergates'): HermesPluginRow {
  return { name, version: '0.2.0', runtime_status }
}

interface Server {
  health?: PluginProbe | Error
  hermes?: string | Error
  rows?: HermesPluginRow[]
}

function serverWith({ health = answered(currentHealth()), hermes = '0.21.6', rows = [] }: Server = {}): FakeGateway {
  const gateway = new FakeGateway()
  gateway.ergates.setHealth(health)
  gateway.setHermesVersion(hermes)
  gateway.plugins.rows = rows
  return gateway
}

describe('checkServer: a plugin that answers', () => {
  it('is ready when the plugin fits this app', async () => {
    const health = currentHealth()
    const check = await checkServer(serverWith({ health: answered(health) }), buildRecord())

    expect(check).toEqual({ kind: 'ready', health })
  })

  it('is outdated, as a manual copy, when an older plugin leaves out the new fields', async () => {
    const check = await checkServer(serverWith({ health: answered(OLDER_HEALTH), hermes: '0.21.7' }), buildRecord())

    expect(check).toEqual({ kind: 'outdated', health: OLDER_HEALTH, installKind: 'manual copy', hermesVersion: '0.21.7' })
  })

  it('is outdated when the plugin cannot write its store', async () => {
    const health = currentHealth({ store: { plugin_schema_version: 1, min_schema_version: 1, writable: false } })
    const check = await checkServer(serverWith({ health: answered(health) }), buildRecord())

    expect(check).toMatchObject({ kind: 'outdated', health, installKind: 'git install' })
  })

  it('is outdated, as a deployment, when the plugin is below the API level of this app', async () => {
    const health = currentHealth({ api_level: 0, install: { kind: 'deployment', commit: null, catalog_name: null } })
    const check = await checkServer(serverWith({ health: answered(health) }), buildRecord())

    expect(check).toEqual({ kind: 'outdated', health, installKind: 'deployment', hermesVersion: '0.21.6' })
  })

  it('reports the Hermes version as null when Hermes does not answer its status', async () => {
    const check = await checkServer(serverWith({ health: answered(OLDER_HEALTH), hermes: new GatewayError('network', 'No connection.') }), buildRecord())

    expect(check).toMatchObject({ kind: 'outdated', hermesVersion: null })
  })

  it('is app_outdated when the plugin needs a newer app', async () => {
    const health = currentHealth({ api_level: 2, min_api_level: 2 })
    const check = await checkServer(serverWith({ health: answered(health) }), buildRecord())

    expect(check).toEqual({ kind: 'app_outdated', health })
  })

  it('asks Hermes for its version only when the answer needs it', async () => {
    const gateway = serverWith()
    const status = vi.spyOn(gateway, 'status')

    await checkServer(gateway, buildRecord())
    expect(status).not.toHaveBeenCalled()

    gateway.ergates.setHealth(answered(OLDER_HEALTH))
    await checkServer(gateway, buildRecord())
    expect(status).toHaveBeenCalledTimes(1)
  })

  it('leaves the hub list alone', async () => {
    const gateway = serverWith({ health: answered(OLDER_HEALTH) })
    const hub = vi.spyOn(gateway.plugins, 'hub')

    await checkServer(gateway, buildRecord())

    expect(hub).not.toHaveBeenCalled()
  })
})

describe('checkServer: a plugin that is not there', () => {
  it('is missing and installable in one tap on a Hermes in the tested range', async () => {
    const check = await checkServer(serverWith({ health: { state: 'absent' } }), buildRecord())

    expect(check).toEqual({ kind: 'missing', hermesVersion: '0.21.6', oneTap: true, reason: null })
  })

  it('is missing when the hub does not list it, whatever else it lists', async () => {
    const check = await checkServer(serverWith({ health: { state: 'absent' }, rows: [row('enabled', 'other')] }), buildRecord())

    expect(check).toMatchObject({ kind: 'missing', oneTap: true })
  })

  it.each([
    ['0.22.0', 'untested'],
    ['1.0.0', 'untested'],
    ['0.21.5', 'too_old'],
    ['unknown', 'unknown'],
    ['0.21.6rc1', 'unknown']
  ])('is missing without a one-tap install on Hermes %s (%s)', async (hermes, reason) => {
    const check = await checkServer(serverWith({ health: { state: 'absent' }, hermes }), buildRecord())

    expect(check).toEqual({ kind: 'missing', hermesVersion: hermes, oneTap: false, reason })
  })

  it('is missing without a one-tap install when Hermes does not answer its status', async () => {
    const check = await checkServer(serverWith({ health: { state: 'absent' }, hermes: new GatewayError('timeout', 'Timed out.') }), buildRecord())

    expect(check).toEqual({ kind: 'missing', hermesVersion: null, oneTap: false, reason: 'unknown' })
  })

  it('is missing without a one-tap install when this build has no commit', async () => {
    const check = await checkServer(serverWith({ health: { state: 'absent' } }), buildRecord(null))

    expect(check).toEqual({ kind: 'missing', hermesVersion: '0.21.6', oneTap: false, reason: 'no_commit' })
  })

  it('names the missing commit before the Hermes version', async () => {
    const check = await checkServer(serverWith({ health: { state: 'absent' }, hermes: '0.22.0' }), buildRecord(null))

    expect(check).toMatchObject({ kind: 'missing', oneTap: false, reason: 'no_commit' })
  })

  it('is missing without a one-tap install when there is no build record', async () => {
    const check = await checkServer(serverWith({ health: { state: 'absent' } }), null)

    expect(check).toEqual({ kind: 'missing', hermesVersion: '0.21.6', oneTap: false, reason: 'no_commit' })
  })

  it.each([['disabled'], ['inactive']] as const)('is disabled when the hub lists it as %s', async status => {
    const check = await checkServer(serverWith({ health: { state: 'absent' }, rows: [row(status)] }), buildRecord())

    expect(check).toEqual({ kind: 'disabled', hermesVersion: '0.21.6' })
  })

  it('is not_loaded when the plugin is enabled but its routes are not mounted', async () => {
    const check = await checkServer(serverWith({ health: { state: 'not_loaded' } }), buildRecord())

    expect(check).toEqual({ kind: 'not_loaded', hermesVersion: '0.21.6' })
  })

  it('is not_loaded when the hub says enabled right after the health read said absent', async () => {
    const check = await checkServer(serverWith({ health: { state: 'absent' }, rows: [row('enabled')] }), buildRecord())

    expect(check).toEqual({ kind: 'not_loaded', hermesVersion: '0.21.6' })
  })

  it('asks the hub only after the health read said absent', async () => {
    const gateway = serverWith({ health: { state: 'not_loaded' } })
    const hub = vi.spyOn(gateway.plugins, 'hub')

    await checkServer(gateway, buildRecord())
    expect(hub).not.toHaveBeenCalled()

    gateway.ergates.setHealth({ state: 'absent' })
    await checkServer(gateway, buildRecord())
    expect(hub).toHaveBeenCalledTimes(1)
  })

  it('treats the plugin as missing when the hub list cannot be read', async () => {
    const gateway = serverWith({ health: { state: 'absent' } })
    gateway.plugins.fail('hub', new GatewayError('network', 'No connection.'))

    const check = await checkServer(gateway, buildRecord())

    expect(check).toEqual({ kind: 'missing', hermesVersion: '0.21.6', oneTap: true, reason: null })
  })

  it('rejects when the hub list needs a sign-in', async () => {
    const gateway = serverWith({ health: { state: 'absent' } })
    gateway.plugins.fail('hub', mapHttpError(401))

    await expect(checkServer(gateway, buildRecord())).rejects.toMatchObject({ kind: 'unauthorized' })
  })
})

describe('checkServer: a health read that fails', () => {
  it.each([
    ['network', new GatewayError('network', 'No connection.')],
    ['timeout', new GatewayError('timeout', 'Timed out.')],
    ['a server error', mapHttpError(502)],
    ['an error nobody classified', new GatewayError('unknown', 'Something broke.')]
  ])('is unknown after %s', async (_title, error) => {
    const check = await checkServer(serverWith({ health: error }), buildRecord())

    expect(check).toEqual({ kind: 'unknown' })
  })

  it('is unavailable, with the server\'s message, when the plugin cannot reach its store', async () => {
    const error = mapErgatesError(503, { error: { code: 'store_unavailable', message: 'the Ergates control store is unavailable' } })
    const check = await checkServer(serverWith({ health: error }), buildRecord())

    expect(check).toEqual({ kind: 'unavailable', message: 'the Ergates control store is unavailable' })
  })

  it('rejects with the unauthorized error so the caller can send the user to sign in', async () => {
    const error = mapHttpError(401)

    await expect(checkServer(serverWith({ health: error }), buildRecord())).rejects.toBe(error)
  })

  it('is unknown after a failure that is not a gateway error', async () => {
    const check = await checkServer(serverWith({ health: new TypeError('fetch failed') }), buildRecord())

    expect(check).toEqual({ kind: 'unknown' })
  })

  it('asks nothing more after a failed health read', async () => {
    const gateway = serverWith({ health: new GatewayError('network', 'No connection.') })
    const status = vi.spyOn(gateway, 'status')
    const hub = vi.spyOn(gateway.plugins, 'hub')

    await checkServer(gateway, buildRecord())

    expect(status).not.toHaveBeenCalled()
    expect(hub).not.toHaveBeenCalled()
  })
})

describe('checkServer: a build without a record', () => {
  it('is ready when the plugin can write its store', async () => {
    const health = currentHealth()

    expect(await checkServer(serverWith({ health: answered(health) }), null)).toEqual({ kind: 'ready', health })
  })

  it('is ready when an older plugin reports no store at all', async () => {
    expect(await checkServer(serverWith({ health: answered(OLDER_HEALTH) }), null)).toEqual({ kind: 'ready', health: OLDER_HEALTH })
  })

  it('is outdated when the plugin cannot write its store', async () => {
    const health = currentHealth({ store: { plugin_schema_version: 1, min_schema_version: 1, writable: false }, install: { kind: 'deployment', commit: null, catalog_name: null } })

    expect(await checkServer(serverWith({ health: answered(health) }), null)).toEqual({ kind: 'outdated', health, installKind: 'deployment', hermesVersion: '0.21.6' })
  })

  it('does not judge the API level without a record', async () => {
    const health = currentHealth({ api_level: 0 })

    expect(await checkServer(serverWith({ health: answered(health) }), null)).toMatchObject({ kind: 'ready' })
  })
})

describe('pluginFits', () => {
  it('fits a plugin whose levels bracket the app', () => {
    expect(pluginFits(currentHealth({ api_level: 3, min_api_level: 1 }), 2)).toBe('fits')
    expect(pluginFits(currentHealth({ api_level: 2, min_api_level: 2 }), 2)).toBe('fits')
  })

  it('counts a missing api_level as 0', () => {
    expect(pluginFits(OLDER_HEALTH, 1)).toBe('plugin_too_old')
  })

  it('finds a plugin below the app\'s level too old', () => {
    expect(pluginFits(currentHealth({ api_level: 1, min_api_level: 1 }), 2)).toBe('plugin_too_old')
  })

  it('finds a plugin that cannot write its store too old', () => {
    const health = currentHealth({ store: { plugin_schema_version: 1, min_schema_version: 1, writable: false } })

    expect(pluginFits(health, 1)).toBe('plugin_too_old')
  })

  it('finds an app below the plugin\'s minimum too old', () => {
    expect(pluginFits(currentHealth({ api_level: 3, min_api_level: 2 }), 1)).toBe('app_too_old')
  })

  it('judges a plugin with no minimum by its level alone', () => {
    expect(pluginFits({ ...OLDER_HEALTH, api_level: 1 }, 1)).toBe('fits')
  })
})
