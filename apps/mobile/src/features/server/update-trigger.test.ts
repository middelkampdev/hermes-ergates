/**
 * When the update shows up: which of the three things happens for a check that
 * offers one. The switch off never opens a screen by itself and never updates
 * silently; a target runs silently at most once.
 */
import { describe, expect, it } from 'vitest'

import { FAKE_PLUGIN_HEALTH, FAKE_SETUP } from '@test/fake-gateway/fake-ergates'

import type { Connection } from '@/state/device-store'

import type { UpdateOffer } from './plugin-version'
import type { ServerCheck } from './server-check'
import type { UpdateOutcome } from './update-run'
import { actionToTake, answerKey, silentRunPatch, updateAction, updateLineFor, updatedNoticeLine } from './update-trigger'

const COMMIT = 'b'.repeat(40)
const OLDER_COMMIT = 'c'.repeat(40)
const offer: UpdateOffer = { from: '0.2.0', to: '0.3.0', commit: COMMIT, previous: 'a'.repeat(40), previousSchema: 1 }

const connection: Connection = { id: 'c1', label: 'A', baseUrl: 'http://a.example', authMode: 'token', primary: true, createdAt: 1 }
const learned: Connection = { ...connection, pluginRemountsFrom: '0.21.6' }

function ready(update: UpdateOffer | null = offer, hermesVersion: string | null = '0.21.6'): ServerCheck {
  return { kind: 'ready', health: FAKE_PLUGIN_HEALTH, update, hermesVersion }
}

function outdated(update: UpdateOffer | null = offer, hermesVersion: string | null = '0.21.6'): ServerCheck {
  return { kind: 'outdated', health: FAKE_PLUGIN_HEALTH, installKind: 'git install', update, hermesVersion }
}

describe('updateAction: no update to offer', () => {
  it.each<[string, ServerCheck | undefined]>([
    ['no check yet', undefined],
    ['a working plugin without an update', ready(null)],
    ['an outdated plugin the app cannot replace', outdated(null)],
    ['a restart that is due', { kind: 'restart_needed', health: FAKE_PLUGIN_HEALTH, hermesVersion: '0.21.6' }],
    ['a missing plugin', { kind: 'missing', hermesVersion: '0.21.6', oneTap: true, reason: null }],
    ['a plugin that is turned off', { kind: 'disabled', hermesVersion: '0.21.6' }],
    ['a plugin Hermes has not loaded', { kind: 'not_loaded', hermesVersion: '0.21.6' }],
    ['a plugin newer than the app', { kind: 'app_outdated', health: FAKE_PLUGIN_HEALTH }],
    ['a plugin that cannot open its data', { kind: 'unavailable', message: 'The store is locked.' }],
    ['a server that could not be read', { kind: 'unknown' }]
  ])('does nothing for %s', (_title, check) => {
    expect(updateAction(check, learned, '0.21.6')).toBeNull()
  })
})

describe('updateAction: the screen opens once per update', () => {
  it.each<[string, ServerCheck]>([
    ['a working plugin', ready()],
    ['a plugin that needs the update', outdated()]
  ])('opens the screen for %s the user was not asked about yet', (_title, check) => {
    expect(updateAction(check, connection, '0.21.6')).toBe('open_screen')
  })

  it('opens the screen again for a new update after the user was asked about an older one', () => {
    expect(updateAction(ready(), { ...connection, askedUpdateFor: OLDER_COMMIT }, '0.21.6')).toBe('open_screen')
  })

  it('shows the line instead once the user was asked about this update', () => {
    expect(updateAction(ready(), { ...connection, askedUpdateFor: COMMIT }, '0.21.6')).toBe('show_line')
    expect(updateAction(outdated(), { ...connection, askedUpdateFor: COMMIT }, '0.21.6')).toBe('show_line')
  })

  it('asks while the Hermes version is not known, because only a known version can run without asking', () => {
    expect(updateAction(ready(offer, null), connection, null)).toBe('open_screen')
  })
})

describe('updateAction: the update runs without asking', () => {
  it.each<[string, string]>([
    ['the version it learned from', '0.21.6'],
    ['a newer patch', '0.21.9'],
    ['a newer minor', '0.23.0']
  ])('runs silently on %s', (_title, hermesVersion) => {
    expect(updateAction(ready(offer, hermesVersion), learned, hermesVersion)).toBe('run_silently')
  })

  it('runs silently for a plugin that needs the update too', () => {
    expect(updateAction(outdated(), learned, '0.21.6')).toBe('run_silently')
  })

  it.each<[string, string | null]>([
    ['an older version than it learned from', '0.21.5'],
    ['a version the server did not report', null],
    ['a version the app cannot read', 'unknown'],
    ['a pre-release version it cannot order', '0.21.7-rc.1']
  ])('asks on %s', (_title, hermesVersion) => {
    expect(updateAction(ready(offer, hermesVersion), learned, hermesVersion)).toBe('open_screen')
  })

  it('asks while the connection has learned nothing', () => {
    expect(updateAction(ready(), connection, '0.21.9')).toBe('open_screen')
  })

  it('runs a target silently once: after the run started it shows the line, so a failed run is not tried again at every check', () => {
    expect(updateAction(ready(), { ...learned, askedUpdateFor: COMMIT }, '0.21.6')).toBe('show_line')
    expect(updateAction(outdated(), { ...learned, askedUpdateFor: COMMIT }, '0.21.6')).toBe('show_line')
  })

  it('runs a newer target silently after an older one ran', () => {
    expect(updateAction(ready(), { ...learned, askedUpdateFor: OLDER_COMMIT }, '0.21.6')).toBe('run_silently')
  })
})

describe('updateAction: the switch is off', () => {
  const off: Connection = { ...connection, autoUpdatePlugin: false }

  it.each<[string, ServerCheck]>([
    ['a working plugin', ready()],
    ['a plugin that needs the update', outdated()]
  ])('only shows the line for %s, whether or not the user was asked', (_title, check) => {
    expect(updateAction(check, off, '0.21.6')).toBe('show_line')
    expect(updateAction(check, { ...off, askedUpdateFor: COMMIT }, '0.21.6')).toBe('show_line')
    expect(updateAction(check, { ...off, askedUpdateFor: OLDER_COMMIT }, '0.21.6')).toBe('show_line')
  })

  it('never updates silently, even on a Hermes the connection learned about', () => {
    expect(updateAction(ready(), { ...off, ...learned, autoUpdatePlugin: false }, '0.21.9')).toBe('show_line')
    expect(updateAction(outdated(), { ...off, ...learned, autoUpdatePlugin: false }, '0.21.9')).toBe('show_line')
  })

  it('still says nothing when there is no update', () => {
    expect(updateAction(ready(null), off, '0.21.6')).toBeNull()
  })
})

describe('updateLineFor', () => {
  const line = { text: 'An update for the Ergates plugin is ready.', action: { label: 'Update', route: '/server/update' } }
  const asked: Connection = { ...connection, askedUpdateFor: COMMIT }

  it('offers the update once the user was asked about it', () => {
    expect(updateLineFor(ready(), asked)).toEqual(line)
  })

  it('offers the update with the switch off, asked or not', () => {
    expect(updateLineFor(ready(), { ...connection, autoUpdatePlugin: false })).toEqual(line)
    expect(updateLineFor(ready(), { ...asked, autoUpdatePlugin: false })).toEqual(line)
  })

  it('offers the update again after a run without asking failed', () => {
    expect(updateLineFor(ready(), { ...learned, askedUpdateFor: COMMIT })).toEqual(line)
  })

  it('stays out while the screen opens by itself or the update runs by itself', () => {
    expect(updateLineFor(ready(), connection)).toBeNull()
    expect(updateLineFor(ready(), learned)).toBeNull()
  })

  it('leaves a plugin that needs the update to its notice, which has the same button', () => {
    expect(updateLineFor(outdated(), asked)).toBeNull()
    expect(updateLineFor(outdated(), { ...connection, autoUpdatePlugin: false })).toBeNull()
  })

  it('says nothing without an update or without a check', () => {
    expect(updateLineFor(ready(null), asked)).toBeNull()
    expect(updateLineFor(undefined, asked)).toBeNull()
  })

  it.each<[string, ServerCheck]>([
    ['a restart that is due', { kind: 'restart_needed', health: FAKE_PLUGIN_HEALTH, hermesVersion: '0.21.6' }],
    ['a missing plugin', { kind: 'missing', hermesVersion: '0.21.6', oneTap: true, reason: null }],
    ['a plugin that is turned off', { kind: 'disabled', hermesVersion: '0.21.6' }],
    ['a plugin Hermes has not loaded', { kind: 'not_loaded', hermesVersion: '0.21.6' }],
    ['a plugin newer than the app', { kind: 'app_outdated', health: FAKE_PLUGIN_HEALTH }],
    ['a plugin that cannot open its data', { kind: 'unavailable', message: 'The store is locked.' }],
    ['a server that could not be read', { kind: 'unknown' }]
  ])('says nothing for %s', (_title, check) => {
    expect(updateLineFor(check, asked)).toBeNull()
  })
})

describe('actionToTake', () => {
  const key = answerKey('c1', 1_000)
  const answer: Parameters<typeof actionToTake>[0] = { check: ready(), connection, key, doneKey: null, fresh: true, running: null }

  it('opens the screen for an update to ask about', () => {
    expect(actionToTake(answer)).toBe('open_screen')
  })

  it('runs the update for a connection that learned its Hermes needs no restart', () => {
    expect(actionToTake({ ...answer, connection: learned })).toBe('run_silently')
  })

  it('leaves the line to be shown, and does nothing itself, when the user was asked or the switch is off', () => {
    expect(actionToTake({ ...answer, connection: { ...connection, askedUpdateFor: COMMIT } })).toBeNull()
    expect(actionToTake({ ...answer, connection: { ...connection, autoUpdatePlugin: false } })).toBeNull()
  })

  it('does nothing without an update', () => {
    expect(actionToTake({ ...answer, check: ready(null) })).toBeNull()
    expect(actionToTake({ ...answer, check: undefined })).toBeNull()
  })

  it('acts once for one answer of one connection', () => {
    expect(actionToTake({ ...answer, doneKey: key })).toBeNull()
    expect(actionToTake({ ...answer, connection: learned, doneKey: key })).toBeNull()
  })

  it('acts on the next answer, and on another connection with the same answer time', () => {
    expect(actionToTake({ ...answer, doneKey: answerKey('c1', 500) })).toBe('open_screen')
    expect(actionToTake({ ...answer, doneKey: answerKey('c2', 1_000) })).toBe('open_screen')
  })

  it('does not act on an answer that is no longer fresh', () => {
    expect(actionToTake({ ...answer, fresh: false })).toBeNull()
    expect(actionToTake({ ...answer, connection: learned, fresh: false })).toBeNull()
  })

  it.each(['setup', 'update'] as const)('does not act while a %s is running for the connection', running => {
    expect(actionToTake({ ...answer, running })).toBeNull()
    expect(actionToTake({ ...answer, connection: learned, running })).toBeNull()
  })
})

describe('silentRunPatch', () => {
  const done: UpdateOutcome = { kind: 'done', setup: FAKE_SETUP }

  it('notes the version the server was updated to, so Home says so once', () => {
    expect(silentRunPatch(done, offer)).toEqual({ pluginUpdatedNotice: '0.3.0' })
  })

  it('forgets that this Hermes needs no restart when the update did need one', () => {
    const patch = silentRunPatch({ kind: 'restart' }, offer)

    expect(Object.keys(patch)).toEqual(['pluginRemountsFrom'])
    expect(patch.pluginRemountsFrom).toBeUndefined()
  })

  it.each<[string, UpdateOutcome]>([
    ['Hermes refuses the install', { kind: 'manual', failure: 'refused', detail: null }],
    ['a step fails', { kind: 'failed', step: 'install', message: 'Lost the connection to your server during the update.' }],
    ['the session ended', { kind: 'sign_in' }],
    ['the first look no longer offered it', { kind: 'stale' }]
  ])('records nothing more when %s, so the line offers the update', (_title, outcome) => {
    expect(silentRunPatch(outcome, offer)).toEqual({})
  })
})

describe('updatedNoticeLine', () => {
  it('names the version the server was updated to', () => {
    expect(updatedNoticeLine('0.3.0')).toBe('Ergates updated the plugin on your server to 0.3.0.')
  })
})
