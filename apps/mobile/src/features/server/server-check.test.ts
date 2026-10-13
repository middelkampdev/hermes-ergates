import { describe, expect, it, vi } from 'vitest'

import { GatewayError, mapErgatesError, mapHttpError } from '@/gateway/errors'
import type { ErgatesHealth, HermesPluginRow, PluginProbe } from '@/gateway/types'
import { FakeGateway } from '@test/fake-gateway/fake-gateway'

import type { BuildRecord } from './build-record'
import { checkServer, isSignedOut, pluginFits, pluginPresence, pollInterval } from './server-check'

const COMMIT = 'b'.repeat(40)
const OLD_COMMIT = 'a'.repeat(40)
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
    install: { kind: 'git install', commit: COMMIT, loaded_commit: COMMIT, catalog_name: null },
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

    expect(check).toEqual({ kind: 'ready', health, update: null, hermesVersion: null })
  })

  it('is outdated, as a manual copy, when an older plugin leaves out the new fields', async () => {
    const check = await checkServer(serverWith({ health: answered(OLDER_HEALTH), hermes: '0.21.7' }), buildRecord())

    expect(check).toEqual({ kind: 'outdated', health: OLDER_HEALTH, installKind: 'manual copy', update: null, hermesVersion: '0.21.7' })
  })

  it('is outdated when the plugin cannot write its store', async () => {
    const health = currentHealth({ store: { plugin_schema_version: 1, min_schema_version: 1, writable: false } })
    const check = await checkServer(serverWith({ health: answered(health) }), buildRecord())

    expect(check).toMatchObject({ kind: 'outdated', health, installKind: 'git install' })
  })

  it('is outdated, as a deployment, when the plugin is below the API level of this app', async () => {
    const health = currentHealth({ api_level: 0, install: { kind: 'deployment', commit: null, catalog_name: null } })
    const check = await checkServer(serverWith({ health: answered(health) }), buildRecord())

    expect(check).toEqual({ kind: 'outdated', health, installKind: 'deployment', update: null, hermesVersion: '0.21.6' })
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
    const check = await checkServer(serverWith({ health: { state: 'not_loaded' }, rows: [row('enabled')] }), buildRecord())

    expect(check).toEqual({ kind: 'not_loaded', hermesVersion: '0.21.6' })
  })

  it('is missing when the health read found no routes and the hub lists no such plugin', async () => {
    const check = await checkServer(serverWith({ health: { state: 'not_loaded' }, rows: [row('enabled', 'other')] }), buildRecord())

    expect(check).toEqual({ kind: 'missing', hermesVersion: '0.21.6', oneTap: true, reason: null })
  })

  it('is not_loaded when the hub says enabled right after the health read said absent', async () => {
    const check = await checkServer(serverWith({ health: { state: 'absent' }, rows: [row('enabled')] }), buildRecord())

    expect(check).toEqual({ kind: 'not_loaded', hermesVersion: '0.21.6' })
  })

  it.each([['absent'], ['not_loaded']] as const)('asks the hub when the health read said %s', async state => {
    const gateway = serverWith({ health: { state } })
    const hub = vi.spyOn(gateway.plugins, 'hub')

    await checkServer(gateway, buildRecord())

    expect(hub).toHaveBeenCalledTimes(1)
  })

  it.each([['disabled'], ['inactive']] as const)('is still not_loaded when Hermes found no routes and the hub lists the plugin as %s', async status => {
    const check = await checkServer(serverWith({ health: { state: 'not_loaded' }, rows: [row(status)] }), buildRecord())

    expect(check).toEqual({ kind: 'not_loaded', hermesVersion: '0.21.6' })
  })

  it('is still not_loaded when Hermes found no routes and the hub list cannot be read, because that read says the plugin is there', async () => {
    const gateway = serverWith({ health: { state: 'not_loaded' } })
    gateway.plugins.fail('hub', new GatewayError('network', 'No connection.'))

    expect(await checkServer(gateway, buildRecord())).toEqual({ kind: 'not_loaded', hermesVersion: '0.21.6' })
  })

  it('rejects when the hub list needs a sign-in after Hermes found no routes', async () => {
    const gateway = serverWith({ health: { state: 'not_loaded' } })
    gateway.plugins.fail('hub', mapHttpError(401))

    await expect(checkServer(gateway, buildRecord())).rejects.toMatchObject({ kind: 'unauthorized' })
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

describe('checkServer: a plugin that waits for a restart', () => {
  const installed = (commit: string | null, loaded: string | null | undefined, kind: 'git install' | 'deployment' | 'manual copy' = 'git install') => {
    const install = { kind, commit, catalog_name: null }
    return currentHealth({ install: loaded === undefined ? install : { ...install, loaded_commit: loaded } })
  }

  it('is restart_needed when the install record names another commit than the code that answers', async () => {
    const health = installed(COMMIT, OLD_COMMIT)
    const check = await checkServer(serverWith({ health: answered(health) }), buildRecord())

    expect(check).toEqual({ kind: 'restart_needed', health, hermesVersion: '0.21.6' })
  })

  it('is restart_needed when the plugin says nothing of the commit it runs while the record names this build\'s commit', async () => {
    const health = installed(COMMIT, undefined)
    const check = await checkServer(serverWith({ health: answered(health) }), buildRecord())

    expect(check).toEqual({ kind: 'restart_needed', health, hermesVersion: '0.21.6' })
  })

  it('is not restart_needed when a plugin that says nothing of the commit it runs was installed from another commit', async () => {
    const health = installed(OLD_COMMIT, undefined)
    const check = await checkServer(serverWith({ health: answered(health) }), buildRecord())

    expect(check).toMatchObject({ kind: 'ready' })
  })

  it('is ready when the record and the running code name the same commit', async () => {
    const health = installed(COMMIT, COMMIT)
    const check = await checkServer(serverWith({ health: answered(health) }), buildRecord())

    expect(check).toEqual({ kind: 'ready', health, update: null, hermesVersion: null })
  })

  it('does not claim a restart when a git install could not tell which commit it loaded', async () => {
    const health = installed(OLD_COMMIT, null)
    const check = await checkServer(serverWith({ health: answered(health) }), buildRecord())

    expect(check).toMatchObject({ kind: 'ready' })
  })

  it.each(['deployment', 'manual copy'] as const)('does not claim a restart for a %s, which has no commit', async kind => {
    const health = installed(null, null, kind)
    const check = await checkServer(serverWith({ health: answered(health) }), buildRecord())

    expect(check).toMatchObject({ kind: 'ready' })
  })

  it('comes before the fit: a plugin that is also below this app\'s level waits for its restart first', async () => {
    const health = currentHealth({ api_level: 0, install: { kind: 'git install', commit: COMMIT, loaded_commit: OLD_COMMIT, catalog_name: null } })

    expect(await checkServer(serverWith({ health: answered(health) }), buildRecord())).toMatchObject({ kind: 'restart_needed' })
  })

  it('comes before the fit: so does a plugin that needs a newer app', async () => {
    const health = currentHealth({ api_level: 2, min_api_level: 2, install: { kind: 'git install', commit: COMMIT, loaded_commit: OLD_COMMIT, catalog_name: null } })

    expect(await checkServer(serverWith({ health: answered(health) }), buildRecord())).toMatchObject({ kind: 'restart_needed' })
  })

  it('needs no build record to see that the record and the running code differ', async () => {
    const health = installed(COMMIT, OLD_COMMIT)

    expect(await checkServer(serverWith({ health: answered(health) }), null)).toMatchObject({ kind: 'restart_needed' })
  })

  it('reports the Hermes version as null when Hermes does not answer its status', async () => {
    const health = installed(COMMIT, OLD_COMMIT)
    const check = await checkServer(serverWith({ health: answered(health), hermes: new GatewayError('network', 'No connection.') }), buildRecord())

    expect(check).toEqual({ kind: 'restart_needed', health, hermesVersion: null })
  })
})

describe('checkServer: an update for the plugin', () => {
  const OLDER_PLUGIN = currentHealth({ plugin_version: '0.1.0', install: { kind: 'git install', commit: OLD_COMMIT, loaded_commit: OLD_COMMIT, catalog_name: null } })
  const OFFER = { from: '0.1.0', to: '0.2.0', commit: COMMIT, previous: OLD_COMMIT, previousSchema: 1 }

  it('offers it with a plugin that works, and carries the Hermes version to decide how it runs', async () => {
    const check = await checkServer(serverWith({ health: answered(OLDER_PLUGIN), hermes: '0.21.7' }), buildRecord())

    expect(check).toEqual({ kind: 'ready', health: OLDER_PLUGIN, update: OFFER, hermesVersion: '0.21.7' })
  })

  it('carries a null Hermes version when Hermes does not answer its status', async () => {
    const check = await checkServer(serverWith({ health: answered(OLDER_PLUGIN), hermes: new GatewayError('timeout', 'Timed out.') }), buildRecord())

    expect(check).toEqual({ kind: 'ready', health: OLDER_PLUGIN, update: OFFER, hermesVersion: null })
  })

  it('offers it with a plugin that is outdated', async () => {
    const health = currentHealth({ plugin_version: '0.1.0', api_level: 0, install: { kind: 'git install', commit: OLD_COMMIT, loaded_commit: OLD_COMMIT, catalog_name: null } })
    const check = await checkServer(serverWith({ health: answered(health) }), buildRecord())

    expect(check).toEqual({ kind: 'outdated', health, installKind: 'git install', update: OFFER, hermesVersion: '0.21.6' })
  })

  it('replaces an outdated plugin of the same version, which a working one would keep', async () => {
    const sameVersion = { ...OLDER_PLUGIN, plugin_version: '0.2.0' }

    expect(await checkServer(serverWith({ health: answered(sameVersion) }), buildRecord())).toMatchObject({ kind: 'ready', update: null })
    expect(await checkServer(serverWith({ health: answered({ ...sameVersion, api_level: 0 }) }), buildRecord())).toMatchObject({ kind: 'outdated', update: { from: '0.2.0', to: '0.2.0', commit: COMMIT } })
  })

  it('asks Hermes for its version only when there is an update to offer', async () => {
    const gateway = serverWith({ health: answered({ ...OLDER_PLUGIN, plugin_version: '0.2.0' }) })
    const status = vi.spyOn(gateway, 'status')

    await checkServer(gateway, buildRecord())
    expect(status).not.toHaveBeenCalled()

    gateway.ergates.setHealth(answered(OLDER_PLUGIN))
    await checkServer(gateway, buildRecord())
    expect(status).toHaveBeenCalledTimes(1)
  })

  it('never replaces a plugin that is newer than this app, ready or outdated', async () => {
    const newer = { ...OLDER_PLUGIN, plugin_version: '0.4.0' }

    expect(await checkServer(serverWith({ health: answered(newer) }), buildRecord())).toMatchObject({ kind: 'ready', update: null })
    expect(await checkServer(serverWith({ health: answered({ ...newer, api_level: 0 }) }), buildRecord())).toMatchObject({ kind: 'outdated', update: null })
  })

  it('leaves a deployment and a manual copy alone, outdated or not', async () => {
    for (const install of [
      { kind: 'deployment', commit: null, loaded_commit: null, catalog_name: null },
      { kind: 'manual copy', commit: null, loaded_commit: null, catalog_name: null }
    ] as const) {
      const working = { ...OLDER_PLUGIN, install }

      expect(await checkServer(serverWith({ health: answered(working) }), buildRecord())).toMatchObject({ kind: 'ready', update: null, hermesVersion: null })
      expect(await checkServer(serverWith({ health: answered({ ...working, api_level: 0 }) }), buildRecord())).toMatchObject({ kind: 'outdated', update: null, installKind: install.kind })
    }
  })

  it('offers nothing without a build record or a build commit', async () => {
    expect(await checkServer(serverWith({ health: answered(OLDER_PLUGIN) }), null)).toMatchObject({ kind: 'ready', update: null })
    expect(await checkServer(serverWith({ health: answered(OLDER_PLUGIN) }), buildRecord(null))).toMatchObject({ kind: 'ready', update: null })
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

    expect(await checkServer(serverWith({ health: answered(health) }), null)).toEqual({ kind: 'ready', health, update: null, hermesVersion: null })
  })

  it('is ready when an older plugin reports no store at all', async () => {
    expect(await checkServer(serverWith({ health: answered(OLDER_HEALTH) }), null)).toEqual({ kind: 'ready', health: OLDER_HEALTH, update: null, hermesVersion: null })
  })

  it('is outdated when the plugin cannot write its store', async () => {
    const health = currentHealth({ store: { plugin_schema_version: 1, min_schema_version: 1, writable: false }, install: { kind: 'deployment', commit: null, catalog_name: null } })

    expect(await checkServer(serverWith({ health: answered(health) }), null)).toEqual({ kind: 'outdated', health, installKind: 'deployment', update: null, hermesVersion: '0.21.6' })
  })

  it('does not judge the API level without a record', async () => {
    const health = currentHealth({ api_level: 0 })

    expect(await checkServer(serverWith({ health: answered(health) }), null)).toMatchObject({ kind: 'ready' })
  })
})

describe('pluginPresence', () => {
  const probes: Record<'absent' | 'not_loaded', PluginProbe> = { absent: { state: 'absent' }, not_loaded: { state: 'not_loaded' } }

  it('has the plugin when it answered, and does not read the hub list', async () => {
    const gateway = serverWith()
    const hub = vi.spyOn(gateway.plugins, 'hub')

    expect(await pluginPresence(gateway, answered(currentHealth()))).toEqual({ there: true, enabled: true })
    expect(hub).not.toHaveBeenCalled()
  })

  it.each(['absent', 'not_loaded'] as const)('has no plugin when Hermes found none (%s) and the hub does not list it', async state => {
    const gateway = serverWith({ rows: [row('enabled', 'other')] })

    expect(await pluginPresence(gateway, probes[state])).toEqual({ there: false })
  })

  it.each(['absent', 'not_loaded'] as const)('has the plugin as the hub lists it when Hermes found none (%s)', async state => {
    expect(await pluginPresence(serverWith({ rows: [row('enabled')] }), probes[state])).toEqual({ there: true, enabled: true })
    expect(await pluginPresence(serverWith({ rows: [row('disabled')] }), probes[state])).toEqual({ there: true, enabled: false })
  })

  it('trusts a not_loaded read over an unreadable hub list, and an absent read not at all', async () => {
    const unreadable = () => {
      const gateway = serverWith()
      gateway.plugins.fail('hub', new GatewayError('timeout', 'Timed out.'))
      return gateway
    }

    expect(await pluginPresence(unreadable(), probes.not_loaded)).toEqual({ there: true, enabled: null })
    expect(await pluginPresence(unreadable(), probes.absent)).toEqual({ there: false })
  })

  it('rejects when the hub list needs a sign-in', async () => {
    const gateway = serverWith()
    gateway.plugins.fail('hub', mapHttpError(401))

    await expect(pluginPresence(gateway, probes.not_loaded)).rejects.toMatchObject({ kind: 'unauthorized' })
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

describe('isSignedOut', () => {
  it('knows the 401 of the gateway', () => {
    expect(isSignedOut(new GatewayError('unauthorized', 'Sign-in required.', { status: 401 }))).toBe(true)
  })

  it.each<[string, unknown]>([
    ['another gateway error', new GatewayError('network', 'Could not reach the gateway.')],
    ['an error from elsewhere', new Error('boom')],
    ['something that is not an error', 'unauthorized'],
    ['no error', null]
  ])('does not take %s for a sign-out', (_title, error) => {
    expect(isSignedOut(error)).toBe(false)
  })
})

describe('pollInterval', () => {
  it('asks again every 5 seconds for a screen that waits for the server', () => {
    expect(pollInterval(true, null)).toBe(5_000)
    expect(pollInterval(true, new GatewayError('network', 'Could not reach the gateway.'))).toBe(5_000)
  })

  it('does not ask for a screen that does not wait', () => {
    expect(pollInterval(false, null)).toBe(false)
  })

  it('stops asking once the server refused the session, because every call fails until the user signs in again', () => {
    expect(pollInterval(true, new GatewayError('unauthorized', 'Sign-in required.', { status: 401 }))).toBe(false)
  })
})
