/**
 * The setup screen is a thin renderer: every rule and every string it shows
 * comes from `setupView`, so these tests are the screen's specification.
 */
import { describe, expect, it } from 'vitest'

import { FAKE_PLUGIN_HEALTH, FAKE_SETUP } from '@test/fake-gateway/fake-ergates'

import { GatewayError, mapHttpError } from '@/gateway/errors'

import type { BuildRecord } from './build-record'
import type { ServerCheck } from './server-check'
import type { UpdateOffer } from './plugin-version'
import { opensFinish, setupRedirect, setupScreenView, setupView, signedOutView, stepStatusWord, type SetupRunState } from './setup-view'
import type { SetupOutcome, SetupStep, StepStatus } from './setup-run'

const COMMIT = 'abcdef0123456789abcdef0123456789abcdef01'

function buildRecord(commit: string | null = COMMIT): BuildRecord {
  return { requiredPlugin: { version: '0.2.0', apiLevel: 1, commit }, hermesRange: { oldest: '0.21.6', newestMinor: '0.21' } }
}

const INTRO = 'Ergates needs its plugin on your Hermes server for routines, new agents from chat and notification settings. Chat works without it.'
const UNREVIEWED =
  "Hermes calls this an unreviewed source, because the plugin is not in the Hermes plugin catalog yet. Your server downloads it from GitHub and runs Hermes's security check before it installs it."
const SOURCE = 'Ergates server plugin 0.2.0 from github.com/middelkampdev/hermes-ergates, commit abcdef0.'
const NOT_NOW = { label: 'Not now', action: 'not_now' }
const SHOW_ME_HOW = { label: 'Show me how', action: 'finish' }

const oneTap: ServerCheck = { kind: 'missing', hermesVersion: '0.21.6', oneTap: true, reason: null }
const ready: ServerCheck = { kind: 'ready', health: FAKE_PLUGIN_HEALTH, update: null, hermesVersion: null }

function stepsWith(statuses: Partial<Record<SetupStep, StepStatus>> = {}): Record<SetupStep, StepStatus> {
  return { install: 'pending', enable: 'pending', start: 'pending', setup: 'pending', ...statuses }
}

function runWith(outcome: SetupOutcome | null, statuses: Partial<Record<SetupStep, StepStatus>> = {}): SetupRunState {
  return { steps: stepsWith(statuses), outcome }
}

describe('setupView: a server without the plugin', () => {
  it('asks for consent and offers one tap on a Hermes in the tested range', () => {
    expect(setupView(oneTap, buildRecord(), null)).toEqual({
      title: 'Set up your server',
      body: [INTRO],
      source: SOURCE,
      note: UNREVIEWED,
      autoUpdateSwitch: true,
      primary: { label: 'Set up this server', action: 'run' },
      secondary: NOT_NOW,
      steps: null
    })
  })

  it('names the version of the build and only the first 7 characters of its commit', () => {
    const build: BuildRecord = { ...buildRecord(), requiredPlugin: { version: '1.4.2', apiLevel: 2, commit: '1234567890abcdef1234567890abcdef12345678' } }

    expect(setupView(oneTap, build, null).source).toBe('Ergates server plugin 1.4.2 from github.com/middelkampdev/hermes-ergates, commit 1234567.')
  })

  it.each<[string, ServerCheck, string]>([
    [
      'older than the oldest supported',
      { kind: 'missing', hermesVersion: '0.20.1', oneTap: false, reason: 'too_old' },
      'Your server runs Hermes 0.20.1. Update Hermes first (hermes update): one-tap setup needs Hermes 0.21.6 or newer. You can also finish setup on the server.'
    ],
    [
      'newer than the newest tested',
      { kind: 'missing', hermesVersion: '0.22.3', oneTap: false, reason: 'untested' },
      'Ergates is not tested with Hermes 0.22 yet, so you finish setup on the server.'
    ],
    [
      'a version the app cannot read',
      { kind: 'missing', hermesVersion: null, oneTap: false, reason: 'unknown' },
      "Ergates could not read your server's Hermes version, so you finish setup on the server."
    ]
  ])('sends a Hermes %s to the guide with the reason', (_title, check, note) => {
    expect(setupView(check, buildRecord(), null)).toEqual({
      title: 'Set up your server',
      body: [INTRO],
      source: SOURCE,
      note,
      autoUpdateSwitch: true,
      primary: SHOW_ME_HOW,
      secondary: NOT_NOW,
      steps: null
    })
  })

  it.each<[string, BuildRecord | null]>([
    ['a build without a commit', buildRecord(null)],
    ['no build record at all', null]
  ])('offers neither one tap nor the guide for %s, because there is no plugin version to name', (_title, build) => {
    const check: ServerCheck = { kind: 'missing', hermesVersion: '0.21.6', oneTap: false, reason: 'no_commit' }

    expect(setupView(check, build, null)).toEqual({
      title: 'Set up your server',
      body: [INTRO],
      source: null,
      note: 'This build of Ergates does not know which plugin version to install.',
      autoUpdateSwitch: false,
      primary: null,
      secondary: NOT_NOW,
      steps: null
    })
  })

  it('puts the update switch under the source line, and nowhere the source line is missing', () => {
    expect(setupView(oneTap, buildRecord(), null).autoUpdateSwitch).toBe(true)
    expect(setupView({ kind: 'missing', hermesVersion: '0.20.1', oneTap: false, reason: 'too_old' }, buildRecord(), null).autoUpdateSwitch).toBe(true)
    expect(setupView(oneTap, buildRecord(null), null).autoUpdateSwitch).toBe(false)
    expect(setupView({ kind: 'disabled', hermesVersion: '0.21.6' }, buildRecord(), null).autoUpdateSwitch).toBe(false)
    expect(setupView(oneTap, buildRecord(), runWith(null, { install: 'active' })).autoUpdateSwitch).toBe(false)
  })

  it('does not offer one tap without a commit, whatever the check says', () => {
    const view = setupView(oneTap, null, null)

    expect(view.primary).toBeNull()
    expect(view.note).toBe('This build of Ergates does not know which plugin version to install.')
  })
})

describe('setupView: the other checks', () => {
  it('offers to turn on a plugin that is on the server but off', () => {
    expect(setupView({ kind: 'disabled', hermesVersion: '0.21.6' }, buildRecord(), null)).toEqual({
      title: 'Set up your server',
      body: ['The Ergates plugin is on your server but turned off.'],
      source: null,
      note: null,
      autoUpdateSwitch: false,
      primary: { label: 'Turn it on', action: 'turn_on' },
      secondary: NOT_NOW,
      steps: null
    })
  })

  it('offers no turn on to a build without a commit, which cannot run the setup', () => {
    const view = setupView({ kind: 'disabled', hermesVersion: '0.21.6' }, buildRecord(null), null)

    expect(view.body).toEqual(['The Ergates plugin is on your server but turned off.'])
    expect(view.note).toBe('This build of Ergates does not know which plugin version to install.')
    expect(view.primary).toBeNull()
  })

  it('says a ready server is ready and leaves with Done', () => {
    expect(setupView(ready, buildRecord(), null)).toEqual({
      title: 'Set up your server',
      body: ['Your server is ready.'],
      source: null,
      note: null,
      autoUpdateSwitch: false,
      primary: { label: 'Done', action: 'done' },
      secondary: null,
      steps: null
    })
  })

  it.each<[string, ServerCheck]>([
    ['not loaded', { kind: 'not_loaded', hermesVersion: '0.21.6' }],
    ['waiting for a restart', { kind: 'restart_needed', health: FAKE_PLUGIN_HEALTH, hermesVersion: '0.21.6' }],
    ['outdated', { kind: 'outdated', health: FAKE_PLUGIN_HEALTH, installKind: 'git install', update: null, hermesVersion: '0.21.6' }]
  ])('leads a plugin that is %s to the guide, because the user finishes it on the server', (_title, check) => {
    const view = setupView(check, buildRecord(), null)

    expect(view.body).toEqual([])
    expect(view.primary).toEqual(SHOW_ME_HOW)
    expect(view.secondary).toEqual(NOT_NOW)
  })

  it('has nothing to set up for a plugin that is newer than this app, and only lets the user leave', () => {
    expect(setupView({ kind: 'app_outdated', health: FAKE_PLUGIN_HEALTH }, buildRecord(), null)).toEqual({
      title: 'Set up your server',
      body: [],
      source: null,
      note: null,
      autoUpdateSwitch: false,
      primary: null,
      secondary: NOT_NOW,
      steps: null
    })
  })

  it('says the server could not be reached when the check could not tell, and offers to check again', () => {
    expect(setupView({ kind: 'unknown' }, buildRecord(), null)).toEqual({
      title: 'Set up your server',
      body: ['Could not reach your server.'],
      source: null,
      note: null,
      autoUpdateSwitch: false,
      primary: { label: 'Try again', action: 'check_again' },
      secondary: NOT_NOW,
      steps: null
    })
  })

  it('shows the plugin\'s own text when it is unavailable', () => {
    const view = setupView({ kind: 'unavailable', message: 'The store is not available.' }, buildRecord(), null)

    expect(view.body).toEqual(['The store is not available.'])
    expect(view.primary).toBeNull()
    expect(view.secondary).toEqual(NOT_NOW)
  })
})

describe('setupView: while a run is going', () => {
  it('lists the four steps in order with their status, and offers nothing to tap', () => {
    const view = setupView(oneTap, buildRecord(), runWith(null, { install: 'done', enable: 'skipped', start: 'active' }))

    expect(view).toEqual({
      title: 'Set up your server',
      body: [],
      source: null,
      note: null,
      autoUpdateSwitch: false,
      primary: null,
      secondary: null,
      steps: [
        { label: 'Installing the plugin', status: 'done' },
        { label: 'Turning it on', status: 'skipped' },
        { label: 'Starting it', status: 'active' },
        { label: 'Setting up your agents', status: 'pending' }
      ]
    })
  })

  it('follows the run, not the check, which may change under it', () => {
    const during: ServerCheck[] = [oneTap, ready, { kind: 'not_loaded', hermesVersion: '0.21.6' }, { kind: 'unknown' }]

    const views = during.map(check => setupView(check, buildRecord(), runWith(null, { install: 'active' })))

    expect(new Set(views.map(view => JSON.stringify(view))).size).toBe(1)
  })
})

describe('setupView: a run that ended', () => {
  const allDone = { install: 'done', enable: 'done', start: 'done', setup: 'done' } as const

  it('says the server is ready and leaves with Done, keeping the ticks', () => {
    const view = setupView(oneTap, buildRecord(), runWith({ kind: 'done', setup: FAKE_SETUP }, allDone))

    expect(view.body).toEqual(['Your server is ready.'])
    expect(view.primary).toEqual({ label: 'Done', action: 'done' })
    expect(view.secondary).toBeNull()
    expect(view.steps?.map(step => step.status)).toEqual(['done', 'done', 'done', 'done'])
  })

  it('names the agents Ergates could not be turned on for', () => {
    const setup = { ...FAKE_SETUP, finished: false, profiles: [{ name: 'default', enabled: true }, { name: 'work', enabled: false, error: 'locked' }, { name: 'home', enabled: false }] }

    const view = setupView(oneTap, buildRecord(), runWith({ kind: 'done', setup }, allDone))

    expect(view.body).toEqual(['Your server is ready.', 'Ergates could not be turned on for: work, home.'])
  })

  it.each<[string, SetupOutcome]>([
    ['the user has to install by hand', { kind: 'manual', failure: 'scan_blocked', detail: null }],
    ['Hermes needs a restart', { kind: 'restart' }]
  ])('leads to the guide when %s, with the step that stopped marked', (_title, outcome) => {
    const view = setupView(oneTap, buildRecord(), runWith(outcome, { install: 'failed' }))

    expect(view.body).toEqual([])
    expect(view.primary).toEqual(SHOW_ME_HOW)
    expect(view.secondary).toEqual(NOT_NOW)
    expect(view.steps?.[0]).toEqual({ label: 'Installing the plugin', status: 'failed' })
  })

  it('asks to sign in again when the server stopped accepting the sign-in', () => {
    const view = setupView(oneTap, buildRecord(), runWith({ kind: 'sign_in' }, { install: 'done', enable: 'skipped', start: 'done', setup: 'failed' }))

    expect(view.body).toEqual(['Your server asked you to sign in again.'])
    expect(view.primary).toEqual({ label: 'Sign in again', action: 'sign_in' })
    expect(view.secondary).toEqual(NOT_NOW)
    expect(view.steps?.[3]).toEqual({ label: 'Setting up your agents', status: 'failed' })
  })

  it('shows the message of a failed step and offers to try again', () => {
    const view = setupView(oneTap, buildRecord(), runWith({ kind: 'failed', step: 'start', message: 'Hermes did not load the plugin.' }, { install: 'done', enable: 'skipped', start: 'failed' }))

    expect(view.body).toEqual(['Hermes did not load the plugin.'])
    expect(view.primary).toEqual({ label: 'Try again', action: 'retry' })
    expect(view.secondary).toEqual(NOT_NOW)
    expect(view.steps?.[2]).toEqual({ label: 'Starting it', status: 'failed' })
  })
})

describe('signedOutView', () => {
  it('asks to sign in again without a list of steps, for a check the server refused', () => {
    expect(signedOutView()).toEqual({
      title: 'Set up your server',
      body: ['Your server asked you to sign in again.'],
      source: null,
      note: null,
      autoUpdateSwitch: false,
      primary: { label: 'Sign in again', action: 'sign_in' },
      secondary: NOT_NOW,
      steps: null
    })
  })
})

describe('setupScreenView: the check as the screen holds it', () => {
  const signedOut = mapHttpError(401, { detail: 'Unauthorized' })
  const unknown: ServerCheck = { kind: 'unknown' }

  it('waits for the first answer', () => {
    expect(setupScreenView({ data: undefined, error: null }, buildRecord(), null)).toBeNull()
  })

  it('shows the view for the check once it answered', () => {
    expect(setupScreenView({ data: oneTap, error: null }, buildRecord(), null)).toEqual(setupView(oneTap, buildRecord(), null))
  })

  it('asks to sign in again when the first check was refused', () => {
    expect(setupScreenView({ data: undefined, error: signedOut }, buildRecord(), null)).toEqual(signedOutView())
  })

  it('lets a refused check win over the older answer it still holds, so Try again after an unreachable server asks to sign in', () => {
    expect(setupScreenView({ data: unknown, error: signedOut }, buildRecord(), null)).toEqual(signedOutView())
    expect(setupScreenView({ data: oneTap, error: signedOut }, buildRecord(), null)).toEqual(signedOutView())
  })

  it('reads any other failed check as a server it could not reach', () => {
    const lost = new GatewayError('network', 'No connection to the gateway.')

    expect(setupScreenView({ data: undefined, error: lost }, buildRecord(), null)).toEqual(setupView(unknown, buildRecord(), null))
    expect(setupScreenView({ data: oneTap, error: lost }, buildRecord(), null)).toEqual(setupView(oneTap, buildRecord(), null))
  })

  it('lets a run decide, whatever the check says', () => {
    const run = runWith(null, { install: 'active' })

    expect(setupScreenView({ data: oneTap, error: signedOut }, buildRecord(), run)).toEqual(setupView(unknown, buildRecord(), run))
    expect(setupScreenView({ data: undefined, error: null }, buildRecord(), run)).toEqual(setupView(unknown, buildRecord(), run))
  })
})

describe('opensFinish', () => {
  it.each<[string, SetupOutcome]>([
    ['a manual install', { kind: 'manual', failure: 'refused', detail: 'Hermes said no.' }],
    ['a manual install without Hermes text', { kind: 'manual', failure: 'no_git', detail: null }],
    ['a restart', { kind: 'restart' }]
  ])('says %s leads to the Finish screen', (_title, outcome) => {
    expect(opensFinish(outcome)).toBe(true)
  })

  it.each<[string, SetupOutcome | null]>([
    ['no outcome', null],
    ['a run that is done', { kind: 'done', setup: FAKE_SETUP }],
    ['a sign-in', { kind: 'sign_in' }],
    ['a failed step', { kind: 'failed', step: 'install', message: 'Something went wrong during setup.' }]
  ])('says %s does not lead to the Finish screen', (_title, outcome) => {
    expect(opensFinish(outcome)).toBe(false)
  })
})

describe('stepStatusWord', () => {
  it('gives every status a word for a screen reader', () => {
    const words = (['pending', 'active', 'done', 'skipped', 'failed'] as const).map(stepStatusWord)

    expect(words).toEqual(['waiting', 'in progress', 'done', 'not needed', 'failed'])
  })
})

describe('setupRedirect', () => {
  const offer: UpdateOffer = { from: '0.1.0', to: '0.2.0', commit: COMMIT, previous: 'a'.repeat(40), previousSchema: 1 }

  it.each<{ title: string; check: ServerCheck; route: string | null }>([
    { title: 'a plugin Hermes has not loaded', check: { kind: 'not_loaded', hermesVersion: '0.21.6' }, route: '/server/finish' },
    { title: 'a plugin that waits for a restart', check: { kind: 'restart_needed', health: FAKE_PLUGIN_HEALTH, hermesVersion: '0.21.6' }, route: '/server/finish' },
    { title: 'an outdated plugin the app cannot update', check: { kind: 'outdated', health: FAKE_PLUGIN_HEALTH, installKind: 'deployment', update: null, hermesVersion: '0.21.6' }, route: '/server/finish' },
    { title: 'an outdated plugin the app can update', check: { kind: 'outdated', health: FAKE_PLUGIN_HEALTH, installKind: 'git install', update: offer, hermesVersion: '0.21.6' }, route: '/server/update' },
    { title: 'a missing plugin, which this screen sets up', check: oneTap, route: null },
    { title: 'a plugin that is turned off, which this screen turns on', check: { kind: 'disabled', hermesVersion: '0.21.6' }, route: null },
    { title: 'a working plugin', check: ready, route: null },
    { title: 'a working plugin with an update, which has its own line', check: { kind: 'ready', health: FAKE_PLUGIN_HEALTH, update: offer, hermesVersion: '0.21.6' }, route: null },
    { title: 'a plugin newer than the app', check: { kind: 'app_outdated', health: FAKE_PLUGIN_HEALTH }, route: null },
    { title: 'a plugin that cannot open its data', check: { kind: 'unavailable', message: 'The store is locked.' }, route: null },
    { title: 'a server that could not be read', check: { kind: 'unknown' }, route: null }
  ])('for $title it goes to $route', ({ check, route }) => {
    expect(setupRedirect(check)).toBe(route)
  })
})
