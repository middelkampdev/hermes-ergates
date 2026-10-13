/// <reference types="node" />
/**
 * app.config.ts adds the build record to the app: which Ergates plugin the
 * app needs (read from the plugin's own files, so a version bump follows) and
 * the Hermes versions CI has tested. The app reads it back as
 * `Constants.expoConfig.extra.ergates`.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import type { ConfigContext } from 'expo/config'
import { afterEach, describe, expect, it, vi } from 'vitest'

import appConfig, { readBuildRecord } from '../../app.config'

const APP = path.resolve(import.meta.dirname, '../..')
const ROOT = path.resolve(APP, '../..')

function readRepoFile(relativePath: string): string {
  return readFileSync(path.join(ROOT, relativePath), 'utf8')
}

function firstGroup(text: string, pattern: RegExp, what: string): string {
  const found = text.match(pattern)
  if (!found) throw new Error(`The test could not find ${what}.`)
  return found[1]
}

const PLUGIN_YAML = readRepoFile('integrations/ergates/plugin.yaml')
const PLUGIN_VERSION = firstGroup(PLUGIN_YAML, /^version: (\S+)$/m, 'the version in plugin.yaml')
const HERMES_FLOOR = firstGroup(PLUGIN_YAML, /^requires_hermes: "?>=(\d+\.\d+\.\d+)"?$/m, 'requires_hermes in plugin.yaml')
const API_LEVEL = Number(firstGroup(readRepoFile('integrations/ergates/ergates/__init__.py'), /^API_LEVEL = (\d+)$/m, 'API_LEVEL in __init__.py'))
const HERMES_MINOR = HERMES_FLOOR.split('.').slice(0, 2).join('.')

const EXPO_CONFIG = JSON.parse(readFileSync(path.join(APP, 'app.json'), 'utf8')).expo

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('readBuildRecord', () => {
  it('reads the plugin version, the API level and the Hermes floor from the plugin files', () => {
    expect(readBuildRecord(ROOT, HERMES_MINOR, 'a'.repeat(40))).toEqual({
      requiredPlugin: { version: PLUGIN_VERSION, apiLevel: API_LEVEL, commit: 'a'.repeat(40) },
      hermesRange: { oldest: HERMES_FLOOR, newestMinor: HERMES_MINOR }
    })
  })

  it('keeps a build without a commit', () => {
    expect(readBuildRecord(ROOT, HERMES_MINOR, null).requiredPlugin.commit).toBeNull()
  })

  it('accepts a tested minor newer than the Hermes floor', () => {
    const [major, minor] = HERMES_MINOR.split('.').map(Number)
    expect(readBuildRecord(ROOT, `${major}.${minor + 1}`, null).hermesRange.newestMinor).toBe(`${major}.${minor + 1}`)
  })

  it('throws when the tested minor is below the minor of the Hermes floor', () => {
    const [major, minor] = HERMES_MINOR.split('.').map(Number)
    expect(() => readBuildRecord(ROOT, `${major}.${minor - 1}`, null)).toThrow(/below/)
  })

  it('compares the minors as numbers, not as text', () => {
    // "0.9" sorts after "0.21" as text but is an older Hermes.
    expect(() => readBuildRecord(ROOT, '0.9', null)).toThrow(/below/)
  })

  it.each(['0.21.6', '0', 'v0.21', '', 'latest'])('throws when the tested range is "%s", not X.Y', value => {
    expect(() => readBuildRecord(ROOT, value, null)).toThrow(/X\.Y/)
  })
})

describe('app config', () => {
  const context = { config: structuredClone(EXPO_CONFIG) } as unknown as ConfigContext

  it('adds the build record with the commit from ERGATES_PLUGIN_COMMIT', () => {
    vi.stubEnv('ERGATES_PLUGIN_COMMIT', 'b'.repeat(40))

    const result = appConfig(context)

    expect(result).toEqual({
      ...EXPO_CONFIG,
      extra: {
        ...EXPO_CONFIG.extra,
        ergates: readBuildRecord(ROOT, EXPO_CONFIG.extra.hermesTestedThrough, 'b'.repeat(40))
      }
    })
    expect(result.extra?.ergates.requiredPlugin.commit).toBe('b'.repeat(40))
    expect(result.extra?.hermesTestedThrough).toBe(EXPO_CONFIG.extra.hermesTestedThrough)
  })

  it('takes the commit from git when ERGATES_PLUGIN_COMMIT is not set', () => {
    vi.stubEnv('ERGATES_PLUGIN_COMMIT', '')
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim()

    expect(appConfig(context).extra?.ergates.requiredPlugin.commit).toBe(head)
  })

  it('records no commit when git cannot run', () => {
    vi.stubEnv('ERGATES_PLUGIN_COMMIT', '')
    vi.stubEnv('PATH', path.join(APP, 'no-such-folder'))

    expect(appConfig(context).extra?.ergates.requiredPlugin.commit).toBeNull()
  })

  it('trims ERGATES_PLUGIN_COMMIT', () => {
    vi.stubEnv('ERGATES_PLUGIN_COMMIT', ` ${'d'.repeat(40)}\n`)

    expect(appConfig(context).extra?.ergates.requiredPlugin.commit).toBe('d'.repeat(40))
  })

  it('takes the commit from git when ERGATES_PLUGIN_COMMIT is only white space', () => {
    vi.stubEnv('ERGATES_PLUGIN_COMMIT', ' \n')
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim()

    expect(appConfig(context).extra?.ergates.requiredPlugin.commit).toBe(head)
  })

  it.each([
    ['upper case', 'B'.repeat(40)],
    ['short', 'b'.repeat(7)],
    ['too long', 'b'.repeat(41)],
    ['not hex', 'g'.repeat(40)],
    ['a branch name', 'main'],
    ['a commit with text around it', `v1 ${'b'.repeat(40)}`]
  ])('fails the build when ERGATES_PLUGIN_COMMIT is %s, instead of building without a commit', (_title, value) => {
    vi.stubEnv('ERGATES_PLUGIN_COMMIT', value)

    expect(() => appConfig(context)).toThrow('app.config.ts: ERGATES_PLUGIN_COMMIT must be a full commit of 40 lowercase hex characters')
  })

  it('does not change the config it was given', () => {
    vi.stubEnv('ERGATES_PLUGIN_COMMIT', 'c'.repeat(40))
    const given = structuredClone(EXPO_CONFIG)

    appConfig({ config: given } as unknown as ConfigContext)

    expect(given).toEqual(EXPO_CONFIG)
  })
})
