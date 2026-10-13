import { describe, expect, it } from 'vitest'

import type { ErgatesHealth } from '@/gateway/types'
import type { Connection } from '@/state/device-store'

import type { BuildRecord } from './build-record'
import { AUTO_UPDATE_LABEL, autoUpdate, compareVersions, remountsWithoutRestart, updateOffer } from './plugin-version'

const BUILD_COMMIT = 'b'.repeat(40)
const INSTALLED_COMMIT = 'a'.repeat(40)

function buildRecord(overrides: { version?: string; commit?: string | null } = {}): BuildRecord {
  return {
    requiredPlugin: { version: overrides.version ?? '0.3.0', apiLevel: 2, commit: overrides.commit === undefined ? BUILD_COMMIT : overrides.commit },
    hermesRange: { oldest: '0.21.6', newestMinor: '0.21' }
  }
}

function installedHealth(overrides: Partial<ErgatesHealth> = {}): ErgatesHealth {
  return {
    ok: true,
    plugin_version: '0.2.0',
    api_level: 2,
    min_api_level: 1,
    schema_version: 2,
    store: { plugin_schema_version: 2, min_schema_version: 2, writable: true },
    install: { kind: 'git install', commit: INSTALLED_COMMIT, loaded_commit: INSTALLED_COMMIT, catalog_name: null },
    ...overrides
  }
}

describe('compareVersions', () => {
  it('orders two versions by their numbers', () => {
    expect(compareVersions('0.2.0', '0.3.0')).toBe(-1)
    expect(compareVersions('0.3.0', '0.2.0')).toBe(1)
    expect(compareVersions('1.0.0', '0.99.99')).toBe(1)
  })

  it('finds equal versions equal', () => {
    expect(compareVersions('0.3.0', '0.3.0')).toBe(0)
  })

  it('compares numbers, not text', () => {
    expect(compareVersions('0.10.0', '0.9.0')).toBe(1)
    expect(compareVersions('0.2.9', '0.2.10')).toBe(-1)
  })

  it.each([['0.3.0-rc.1'], ['0.3'], ['v0.3.0'], ['0.3.0+4'], ['unknown'], ['']])('cannot order %j', version => {
    expect(compareVersions(version, '0.3.0')).toBeNull()
    expect(compareVersions('0.3.0', version)).toBeNull()
  })
})

describe('updateOffer: a git install behind this build', () => {
  it('offers the build\'s plugin, with the commit and schema it replaces', () => {
    const offer = updateOffer(installedHealth(), buildRecord(), 'optional')

    expect(offer).toEqual({ from: '0.2.0', to: '0.3.0', commit: BUILD_COMMIT, previous: INSTALLED_COMMIT, previousSchema: 2 })
  })

  it('does not know the previous schema of a plugin that reports no store', () => {
    const { store: _store, ...withoutStore } = installedHealth()

    expect(updateOffer(withoutStore, buildRecord(), 'required')).toMatchObject({ previous: INSTALLED_COMMIT, previousSchema: null })
  })

  it('offers it for a plugin that is outdated and one that is ready alike', () => {
    expect(updateOffer(installedHealth(), buildRecord(), 'required')).not.toBeNull()
    expect(updateOffer(installedHealth(), buildRecord(), 'optional')).not.toBeNull()
  })
})

describe('updateOffer: equal versions', () => {
  const sameVersion = installedHealth({ plugin_version: '0.3.0' })

  it('offers no replacement of a working plugin, so two builds of one version never swap it back and forth', () => {
    expect(updateOffer(sameVersion, buildRecord(), 'optional')).toBeNull()
  })

  it('replaces a plugin this app cannot use, because the running plugin cannot serve it', () => {
    expect(updateOffer(sameVersion, buildRecord(), 'required')).toEqual({ from: '0.3.0', to: '0.3.0', commit: BUILD_COMMIT, previous: INSTALLED_COMMIT, previousSchema: 2 })
  })
})

describe('updateOffer: a plugin that is newer than this app', () => {
  it.each(['optional', 'required'] as const)('never replaces it with an older one (%s)', need => {
    expect(updateOffer(installedHealth({ plugin_version: '0.4.0' }), buildRecord({ version: '0.3.0' }), need)).toBeNull()
  })

  it('compares numbers, so 0.10.0 is newer than 0.9.0', () => {
    expect(updateOffer(installedHealth({ plugin_version: '0.10.0' }), buildRecord({ version: '0.9.0' }), 'required')).toBeNull()
  })
})

describe('updateOffer: a plugin the app does not manage', () => {
  it.each(['optional', 'required'] as const)('leaves a deployment alone (%s)', need => {
    const health = installedHealth({ install: { kind: 'deployment', commit: null, loaded_commit: null, catalog_name: null } })

    expect(updateOffer(health, buildRecord(), need)).toBeNull()
  })

  it.each(['optional', 'required'] as const)('leaves a manual copy alone (%s)', need => {
    const health = installedHealth({ install: { kind: 'manual copy', commit: null, loaded_commit: null, catalog_name: null } })

    expect(updateOffer(health, buildRecord(), need)).toBeNull()
  })

  it.each(['optional', 'required'] as const)('leaves a plugin that reports no install alone, because an older plugin was copied by hand (%s)', need => {
    const { install: _install, ...withoutInstall } = installedHealth()

    expect(updateOffer(withoutInstall, buildRecord(), need)).toBeNull()
  })

  it('leaves a git install alone when its commit is unknown, because there is nothing to go back to', () => {
    const health = installedHealth({ install: { kind: 'git install', commit: null, catalog_name: null } })

    expect(updateOffer(health, buildRecord(), 'required')).toBeNull()
  })

  it.each(['optional', 'required'] as const)('leaves a git install from the Hermes catalog alone until catalog updates exist (%s)', need => {
    const health = installedHealth({ install: { kind: 'git install', commit: INSTALLED_COMMIT, loaded_commit: INSTALLED_COMMIT, catalog_name: 'ergates' } })

    expect(updateOffer(health, buildRecord(), need)).toBeNull()
  })
})

describe('updateOffer: an install record the app does not trust as a commit', () => {
  it.each([
    ['upper case', 'A'.repeat(40)],
    ['too short', 'abc123'],
    ['too long', 'a'.repeat(41)],
    ['not hex', 'g'.repeat(40)],
    ['a branch name', 'main'],
    ['blank', ''],
    ['a number', 12345],
    ['an object', { sha: 'a'.repeat(40) }]
  ])('offers nothing when the recorded commit is %s, because going back would install it', (_title, commit) => {
    const install = { kind: 'git install', commit, catalog_name: null } as unknown as ErgatesHealth['install']

    expect(updateOffer(installedHealth({ install }), buildRecord(), 'required')).toBeNull()
  })
})

describe('updateOffer: nothing to install', () => {
  it('offers nothing without a build record', () => {
    expect(updateOffer(installedHealth(), null, 'required')).toBeNull()
  })

  it('offers nothing when the build has no commit', () => {
    expect(updateOffer(installedHealth(), buildRecord({ commit: null }), 'required')).toBeNull()
  })

  it('offers nothing when the plugin is already at the build\'s commit', () => {
    const health = installedHealth({ install: { kind: 'git install', commit: BUILD_COMMIT, loaded_commit: BUILD_COMMIT, catalog_name: null } })

    expect(updateOffer(health, buildRecord(), 'required')).toBeNull()
  })

  it.each([['0.2.0-rc.1'], ['dev'], ['']])('offers nothing when it cannot read the installed version %j', version => {
    expect(updateOffer(installedHealth({ plugin_version: version }), buildRecord(), 'required')).toBeNull()
  })

  it('offers nothing when it cannot read the build\'s version', () => {
    expect(updateOffer(installedHealth(), buildRecord({ version: '0.3.0-rc.1' }), 'required')).toBeNull()
  })
})

describe('autoUpdate', () => {
  const connection: Connection = { id: 'c1', label: 'A', baseUrl: 'http://a.example', authMode: 'token', primary: true, createdAt: 1 }

  it('is on until the user turns it off', () => {
    expect(autoUpdate(connection)).toBe(true)
    expect(autoUpdate({ ...connection, autoUpdatePlugin: true })).toBe(true)
    expect(autoUpdate({ ...connection, autoUpdatePlugin: false })).toBe(false)
  })

  it('has one label on every screen that shows the switch', () => {
    expect(AUTO_UPDATE_LABEL).toBe('Keep it up to date automatically')
  })
})

describe('remountsWithoutRestart', () => {
  const connection: Connection = { id: 'c1', label: 'A', baseUrl: 'http://a.example', authMode: 'token', primary: true, createdAt: 1 }
  const learned: Connection = { ...connection, pluginRemountsFrom: '0.21.6' }

  it.each([
    ['the version it learned from', '0.21.6'],
    ['a newer patch', '0.21.9'],
    ['a newer minor', '0.23.0']
  ])('holds for %s', (_title, hermesVersion) => {
    expect(remountsWithoutRestart(learned, hermesVersion)).toBe(true)
  })

  it.each<[string, string | null]>([
    ['an older version', '0.21.5'],
    ['a version the server did not report', null],
    ['a version the app cannot read', 'unknown'],
    ['a pre-release it cannot order', '0.21.7-rc.1']
  ])('does not hold for %s', (_title, hermesVersion) => {
    expect(remountsWithoutRestart(learned, hermesVersion)).toBe(false)
  })

  it('does not hold before the connection has learned anything', () => {
    expect(remountsWithoutRestart(connection, '0.21.9')).toBe(false)
  })

  it('does not hold for a learned version the app cannot read', () => {
    expect(remountsWithoutRestart({ ...connection, pluginRemountsFrom: 'dev' }, '0.21.9')).toBe(false)
  })
})
