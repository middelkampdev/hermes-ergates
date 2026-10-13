/**
 * The Update ready screen is a thin renderer: every rule and every string it
 * shows comes from `updateView`, so these tests are the screen's specification.
 */
import { describe, expect, it } from 'vitest'

import { FAKE_PLUGIN_HEALTH, FAKE_SETUP } from '@test/fake-gateway/fake-ergates'

import { GatewayError, mapHttpError } from '@/gateway/errors'
import type { Connection } from '@/state/device-store'

import type { UpdateOffer } from './plugin-version'
import type { ServerCheck } from './server-check'
import type { UpdateOutcome, UpdateStep } from './update-run'
import type { StepStatus } from './setup-run'
import { askedOnOpen, offerOf, PENDING_UPDATE_RUN, retryTarget, targetOf, updateScreenView, updateSteps, updateView, type UpdateRunState } from './update-view'

const COMMIT = 'abcdef0123456789abcdef0123456789abcdef01'
const PREVIOUS = '1234567890abcdef1234567890abcdef12345678'

const offer: UpdateOffer = { from: '0.1.0', to: '0.2.0', commit: COMMIT, previous: PREVIOUS, previousSchema: 1 }

const connection: Connection = { id: 'c1', label: 'A', baseUrl: 'http://a.example', authMode: 'token', primary: true, createdAt: 1 }

function ready(hermesVersion: string | null = '0.21.6', update: UpdateOffer | null = offer): ServerCheck {
  return { kind: 'ready', health: FAKE_PLUGIN_HEALTH, update, hermesVersion }
}

const NOT_NOW = { label: 'Not now', action: 'not_now' }
const LATER = { label: 'Later', action: 'later' }
const SHOW_ME_HOW = { label: 'Show me how', action: 'finish' }
const DONE = { label: 'Done', action: 'done' }
const UP_TO_DATE = 'The plugin on your server is up to date.'
const RESTART_NOTE = 'Hermes has to restart to finish the update. Ergates shows you how.'

function stepsWith(statuses: Partial<Record<UpdateStep, StepStatus>> = {}): Record<UpdateStep, StepStatus> {
  return { pause: 'pending', install: 'pending', start: 'pending', setup: 'pending', ...statuses }
}

function runWith(outcome: UpdateOutcome | null, statuses: Partial<Record<UpdateStep, StepStatus>> = {}): UpdateRunState {
  return { steps: stepsWith(statuses), outcome }
}

describe('updateView: an update that is ready', () => {
  it('says which version is ready and which one the server has, names the source, and asks once', () => {
    expect(updateView(offer, ready(), connection, null)).toEqual({
      title: 'Update ready',
      body: ['Ergates server plugin 0.2.0 is ready for your server. You have 0.1.0.'],
      source: 'From github.com/middelkampdev/hermes-ergates, commit abcdef0.',
      note: RESTART_NOTE,
      autoUpdateSwitch: true,
      primary: { label: 'Update now', action: 'update' },
      secondary: LATER,
      steps: null
    })
  })

  it('names only the first 7 characters of the commit', () => {
    expect(updateView({ ...offer, commit: '1234567890abcdef1234567890abcdef12345678' }, ready(), connection, null).source).toBe('From github.com/middelkampdev/hermes-ergates, commit 1234567.')
  })

  it('reads the same for a plugin that needs the update to serve this app', () => {
    const check: ServerCheck = { kind: 'outdated', health: FAKE_PLUGIN_HEALTH, installKind: 'git install', update: offer, hermesVersion: '0.21.6' }

    expect(updateView(offer, check, connection, null)).toMatchObject({ body: ['Ergates server plugin 0.2.0 is ready for your server. You have 0.1.0.'], primary: { label: 'Update now', action: 'update' }, secondary: LATER })
  })

  describe('the restart note', () => {
    it.each<[string, Connection, string | null]>([
      ['a Hermes that has not been seen to start a new plugin without a restart', connection, '0.21.6'],
      ['a Hermes older than the one seen to start it without a restart', { ...connection, pluginRemountsFrom: '0.22.0' }, '0.21.6'],
      ['a Hermes version the server did not report', { ...connection, pluginRemountsFrom: '0.21.6' }, null],
      ['a Hermes version the app cannot read', { ...connection, pluginRemountsFrom: '0.21.6' }, 'unknown']
    ])('stays for %s', (_title, owner, hermesVersion) => {
      expect(updateView(offer, ready(hermesVersion), owner, null).note).toBe(RESTART_NOTE)
    })

    it.each<[string, string]>([
      ['the same version', '0.21.6'],
      ['a newer patch', '0.21.9'],
      ['a newer minor', '0.23.0']
    ])('goes away once the connection learned that this Hermes needs no restart: %s', (_title, hermesVersion) => {
      const owner: Connection = { ...connection, pluginRemountsFrom: '0.21.6' }

      expect(updateView(offer, ready(hermesVersion), owner, null).note).toBeNull()
    })

    it('goes away for a plugin that needs the update too', () => {
      const check: ServerCheck = { kind: 'outdated', health: FAKE_PLUGIN_HEALTH, installKind: 'git install', update: offer, hermesVersion: '0.21.6' }

      expect(updateView(offer, check, { ...connection, pluginRemountsFrom: '0.21.6' }, null).note).toBeNull()
    })
  })
})

describe('updateView: nothing to update', () => {
  it('says a working plugin without an update is up to date and leaves with Done', () => {
    expect(updateView(null, ready('0.21.6', null), connection, null)).toEqual({
      title: 'Update ready',
      body: [UP_TO_DATE],
      source: null,
      note: null,
      autoUpdateSwitch: false,
      primary: DONE,
      secondary: null,
      steps: null
    })
  })

  it.each<[string, ServerCheck, string]>([
    ['a deployment or a manual copy that needs an update', { kind: 'outdated', health: FAKE_PLUGIN_HEALTH, installKind: 'manual copy', update: null, hermesVersion: '0.21.6' }, 'The Ergates plugin on this server needs an update.'],
    ['a restart', { kind: 'restart_needed', health: FAKE_PLUGIN_HEALTH, hermesVersion: '0.21.6' }, 'Restart Hermes to finish the plugin update.'],
    ['a plugin Hermes has not loaded', { kind: 'not_loaded', hermesVersion: '0.21.6' }, 'Hermes has not loaded the Ergates plugin yet.'],
    ['a plugin that is turned off', { kind: 'disabled', hermesVersion: '0.21.6' }, 'The Ergates plugin is turned off on this server.'],
    ['a plugin that is not there', { kind: 'missing', hermesVersion: '0.21.6', oneTap: true, reason: null }, 'Ergates is not set up on this server.'],
    ['a plugin newer than the app', { kind: 'app_outdated', health: FAKE_PLUGIN_HEALTH }, "This server's Ergates plugin needs a newer version of this app. Update Ergates."],
    ['an unavailable plugin', { kind: 'unavailable', message: 'The store is busy.' }, 'The Ergates plugin cannot open its data on this server: The store is busy.']
  ])('shows the notice for %s and never starts a run', (_title, check, text) => {
    const view = updateView(null, check, connection, null)

    expect(view).toMatchObject({ body: [text], source: null, note: null, autoUpdateSwitch: false, primary: DONE, secondary: null, steps: null })
  })

  it('says the server could not be reached when the check could not tell, and offers to check again', () => {
    expect(updateView(null, { kind: 'unknown' }, connection, null)).toEqual({
      title: 'Update ready',
      body: ['Could not reach your server.'],
      source: null,
      note: null,
      autoUpdateSwitch: false,
      primary: { label: 'Try again', action: 'check_again' },
      secondary: NOT_NOW,
      steps: null
    })
  })
})

describe('updateView: while the update runs', () => {
  it('lists the four steps in order with their status, and offers nothing to tap', () => {
    const view = updateView(offer, ready(), connection, runWith(null, { pause: 'done', install: 'active' }))

    expect(view).toEqual({
      title: 'Update ready',
      body: [],
      source: null,
      note: null,
      autoUpdateSwitch: false,
      primary: null,
      secondary: null,
      steps: [
        { label: 'Turning the old version off', status: 'done' },
        { label: 'Installing the update', status: 'active' },
        { label: 'Starting it', status: 'pending' },
        { label: 'Setting up your agents', status: 'pending' }
      ]
    })
  })

  it('shows every step waiting for a screen that has only just started or rejoined the run', () => {
    expect(updateView(offer, ready(), connection, PENDING_UPDATE_RUN)).toMatchObject({
      primary: null,
      secondary: null,
      steps: [
        { label: 'Turning the old version off', status: 'pending' },
        { label: 'Installing the update', status: 'pending' },
        { label: 'Starting it', status: 'pending' },
        { label: 'Setting up your agents', status: 'pending' }
      ]
    })
  })

  it('follows the run, not the check, which changes under it', () => {
    const during: ServerCheck[] = [ready(), ready('0.21.6', null), { kind: 'disabled', hermesVersion: '0.21.6' }, { kind: 'not_loaded', hermesVersion: '0.21.6' }, { kind: 'unknown' }]

    const views = during.map(check => updateView(offer, check, connection, runWith(null, { pause: 'active' })))

    expect(new Set(views.map(view => JSON.stringify(view))).size).toBe(1)
  })
})

describe('updateView: a run that ended', () => {
  const allDone = { pause: 'done', install: 'done', start: 'done', setup: 'done' } as const

  it('says the plugin is up to date and leaves with Done, keeping the ticks', () => {
    const view = updateView(offer, ready(), connection, runWith({ kind: 'done', setup: FAKE_SETUP }, allDone))

    expect(view.body).toEqual([UP_TO_DATE])
    expect(view.primary).toEqual(DONE)
    expect(view.secondary).toBeNull()
    expect(view.steps?.map(step => step.status)).toEqual(['done', 'done', 'done', 'done'])
  })

  it('names the agents Ergates could not be turned on for', () => {
    const setup = { ...FAKE_SETUP, finished: false, profiles: [{ name: 'default', enabled: true }, { name: 'work', enabled: false, error: 'locked' }, { name: 'home', enabled: false }] }

    const view = updateView(offer, ready(), connection, runWith({ kind: 'done', setup }, allDone))

    expect(view.body).toEqual([UP_TO_DATE, 'Ergates could not be turned on for: work, home.'])
  })

  it.each<[string, UpdateOutcome]>([
    ['Hermes needs a restart', { kind: 'restart' }],
    ['the user has to install by hand', { kind: 'manual', failure: 'scan_blocked', detail: null }]
  ])('leads to the guide when %s, with the step that stopped marked', (_title, outcome) => {
    const view = updateView(offer, ready(), connection, runWith(outcome, { pause: 'done', install: 'failed' }))

    expect(view.body).toEqual([])
    expect(view.primary).toEqual(SHOW_ME_HOW)
    expect(view.secondary).toEqual(NOT_NOW)
    expect(view.steps?.[1]).toEqual({ label: 'Installing the update', status: 'failed' })
  })

  it('asks to sign in again when the server stopped accepting the sign-in', () => {
    const view = updateView(offer, ready(), connection, runWith({ kind: 'sign_in' }, { pause: 'done', install: 'done', start: 'done', setup: 'failed' }))

    expect(view.body).toEqual(['Your server asked you to sign in again.'])
    expect(view.primary).toEqual({ label: 'Sign in again', action: 'sign_in' })
    expect(view.secondary).toEqual(NOT_NOW)
    expect(view.steps?.[3]).toEqual({ label: 'Setting up your agents', status: 'failed' })
  })

  it('shows the message of a failed step and offers to try again or to come back later', () => {
    const view = updateView(offer, ready(), connection, runWith({ kind: 'failed', step: 'install', message: 'Lost the connection to your server during the update.' }, { pause: 'done', install: 'failed' }))

    expect(view.body).toEqual(['Lost the connection to your server during the update.'])
    expect(view.primary).toEqual({ label: 'Try again', action: 'retry' })
    expect(view.secondary).toEqual(LATER)
    expect(view.steps?.[1]).toEqual({ label: 'Installing the update', status: 'failed' })
  })
})

describe('updateScreenView: the check as the screen holds it', () => {
  const signedOut = mapHttpError(401, { detail: 'Unauthorized' })

  it('waits for the first answer', () => {
    expect(updateScreenView({ data: undefined, error: null }, connection, null)).toBeNull()
  })

  it('takes the offer from the check once it answered', () => {
    expect(updateScreenView({ data: ready(), error: null }, connection, null)).toEqual(updateView(offer, ready(), connection, null))
  })

  it('takes the offer of a plugin that needs the update too', () => {
    const check: ServerCheck = { kind: 'outdated', health: FAKE_PLUGIN_HEALTH, installKind: 'git install', update: offer, hermesVersion: '0.21.6' }

    expect(updateScreenView({ data: check, error: null }, connection, null)).toEqual(updateView(offer, check, connection, null))
  })

  it('finds no offer in a check that has none', () => {
    expect(updateScreenView({ data: ready('0.21.6', null), error: null }, connection, null)).toEqual(updateView(null, ready('0.21.6', null), connection, null))
  })

  it('asks to sign in again when the check was refused, whatever older answer it still holds', () => {
    const expected = { title: 'Update ready', body: ['Your server asked you to sign in again.'], source: null, note: null, autoUpdateSwitch: false, primary: { label: 'Sign in again', action: 'sign_in' }, secondary: NOT_NOW, steps: null }

    expect(updateScreenView({ data: undefined, error: signedOut }, connection, null)).toEqual(expected)
    expect(updateScreenView({ data: ready(), error: signedOut }, connection, null)).toEqual(expected)
  })

  it('reads any other failed check as a server it could not reach', () => {
    const lost = new GatewayError('network', 'No connection to the gateway.')

    expect(updateScreenView({ data: undefined, error: lost }, connection, null)).toEqual(updateView(null, { kind: 'unknown' }, connection, null))
    expect(updateScreenView({ data: ready(), error: lost }, connection, null)).toEqual(updateView(offer, ready(), connection, null))
  })

  it('lets a run decide, whatever the check says', () => {
    const run = runWith(null, { pause: 'active' })

    expect(updateScreenView({ data: ready(), error: signedOut }, connection, run)).toEqual(updateView(offer, { kind: 'unknown' }, connection, run))
    expect(updateScreenView({ data: undefined, error: null }, connection, run)).toEqual(updateView(offer, { kind: 'unknown' }, connection, run))
  })
})

describe('offerOf: the update a check offers', () => {
  it.each<[string, ServerCheck]>([
    ['a working plugin', ready()],
    ['a plugin that needs the update', { kind: 'outdated', health: FAKE_PLUGIN_HEALTH, installKind: 'git install', update: offer, hermesVersion: '0.21.6' }]
  ])('is the offer of %s', (_title, check) => {
    expect(offerOf(check)).toBe(offer)
  })

  it.each<[string, ServerCheck | undefined]>([
    ['no check', undefined],
    ['a working plugin with nothing to update', ready('0.21.6', null)],
    ['an outdated plugin the app cannot update', { kind: 'outdated', health: FAKE_PLUGIN_HEALTH, installKind: 'deployment', update: null, hermesVersion: null }],
    ['a plugin that waits for a restart', { kind: 'restart_needed', health: FAKE_PLUGIN_HEALTH, hermesVersion: '0.21.6' }],
    ['a check that could not tell', { kind: 'unknown' }]
  ])('is null for %s', (_title, check) => {
    expect(offerOf(check)).toBeNull()
  })
})

describe('targetOf: what runUpdate takes for the commits', () => {
  it('installs the offered commit, and remembers what the server had', () => {
    expect(targetOf(offer)).toEqual({ target: COMMIT, previous: PREVIOUS, previousSchema: 1, goingBack: false })
  })
})

describe('retryTarget: Try again installs only what the server still needs', () => {
  it('takes the target from the offer of the check that was just asked again', () => {
    expect(retryTarget({ data: ready(), error: null })).toEqual({ target: COMMIT, previous: PREVIOUS, previousSchema: 1, goingBack: false })
  })

  it('takes the commits of the new offer, not of the one the failed run started with', () => {
    const newer: UpdateOffer = { from: '0.1.0', to: '0.3.0', commit: 'f'.repeat(40), previous: PREVIOUS, previousSchema: 1 }

    expect(retryTarget({ data: ready('0.21.6', newer), error: null })?.target).toBe('f'.repeat(40))
  })

  it.each<[string, ServerCheck | undefined]>([
    ['an offer that is gone', ready('0.21.6', null)],
    ['a server that now runs a newer plugin than this build', { kind: 'ready', health: { ...FAKE_PLUGIN_HEALTH, plugin_version: '0.9.0' }, update: null, hermesVersion: null }],
    ['a plugin that needs an update the app cannot make', { kind: 'outdated', health: FAKE_PLUGIN_HEALTH, installKind: 'deployment', update: null, hermesVersion: null }],
    ['a plugin that waits for a restart', { kind: 'restart_needed', health: FAKE_PLUGIN_HEALTH, hermesVersion: '0.21.6' }],
    ['no answer', undefined]
  ])('starts no run for %s', (_title, data) => {
    expect(retryTarget({ data, error: null })).toBeNull()
  })

  it('starts no run when asking again failed, whatever the check held before', () => {
    expect(retryTarget({ data: ready(), error: new GatewayError('network', 'No connection to the gateway.') })).toBeNull()
  })
})

describe('askedOnOpen: which commit opening the screen records as asked about', () => {
  it('records the offered commit, so the screen opens by itself once per update whatever the user does there', () => {
    expect(askedOnOpen(offer, connection)).toBe(COMMIT)
  })

  it('records a newer offer over the commit it recorded for an older one', () => {
    expect(askedOnOpen(offer, { ...connection, askedUpdateFor: PREVIOUS })).toBe(COMMIT)
  })

  it('records nothing again for a commit it already recorded', () => {
    expect(askedOnOpen(offer, { ...connection, askedUpdateFor: COMMIT })).toBeNull()
  })

  it('records nothing without an offer', () => {
    expect(askedOnOpen(null, connection)).toBeNull()
  })
})

describe('updateSteps: the labels of a run', () => {
  it('names the steps of an update', () => {
    expect(updateSteps(PENDING_UPDATE_RUN).map(step => step.label)).toEqual(['Turning the old version off', 'Installing the update', 'Starting it', 'Setting up your agents'])
  })

  it('names the steps of a going back for what they do', () => {
    expect(updateSteps(PENDING_UPDATE_RUN, true).map(step => step.label)).toEqual(['Turning the new version off', 'Installing the previous version', 'Starting it', 'Setting up your agents'])
  })
})
