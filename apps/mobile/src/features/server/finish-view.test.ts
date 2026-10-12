/**
 * The Finish screen is a thin renderer: which variant it shows, every string,
 * the command and the buttons come from `finishVariant` and `finishView`, so
 * these tests are the screen's specification.
 */
import { describe, expect, it } from 'vitest'

import { FAKE_PLUGIN_HEALTH } from '@test/fake-gateway/fake-ergates'

import { GatewayError } from '@/gateway/errors'

import type { BuildRecord } from './build-record'
import {
  finishVariant,
  finishView,
  isSignedOut,
  manualFromParams,
  pendingCommit,
  RESTART_HEADING,
  SERVER_GUIDE_URL,
  setupProblem,
  SIGNED_OUT_HINT,
  type FinishManual,
  type FinishVariant
} from './finish-view'
import type { InstallKind, ServerCheck } from './server-check'
import { finishParams, type FinishParams } from './setup-view'

const COMMIT = 'abcdef0123456789abcdef0123456789abcdef01'
const IDENTIFIER = 'middelkampdev/hermes-ergates/integrations/ergates'

function buildRecord(commit: string | null = COMMIT): BuildRecord {
  return { requiredPlugin: { version: '0.2.0', apiLevel: 1, commit }, hermesRange: { oldest: '0.21.6', newestMinor: '0.21' } }
}

const ready: ServerCheck = { kind: 'ready', health: FAKE_PLUGIN_HEALTH }
const waiting: ServerCheck = { kind: 'not_loaded', hermesVersion: '0.21.6' }

type MissingReason = Extract<ServerCheck, { kind: 'missing' }>['reason']

function missing(reason: MissingReason): ServerCheck {
  return { kind: 'missing', hermesVersion: '0.21.6', oneTap: reason === null, reason }
}

function outdated(installKind: InstallKind): ServerCheck {
  return { kind: 'outdated', health: FAKE_PLUGIN_HEALTH, installKind, hermesVersion: '0.21.6' }
}

const install = (extra: Partial<Extract<FinishVariant, { kind: 'install' }>> = {}): FinishVariant => ({ kind: 'install', restart: false, failure: null, detail: null, ...extra })

const RESTART_LINES = [
  'Hermes service: systemctl --user restart hermes-dashboard',
  'Docker: docker restart <container name>',
  'Hermes Desktop: quit it and open it again',
  'Started by hand: stop hermes serve and start it again'
]
const RUN_INTRO = 'On your server, as the user that runs Hermes, run:'

describe('finishVariant: what the check says the user has to do', () => {
  it.each<[string, MissingReason, boolean]>([
    ['in the tested range', null, false],
    ['newer than the tested range', 'untested', false],
    ['a build without a commit', 'no_commit', false],
    ['older than the oldest supported', 'too_old', true],
    ['a version the app cannot read', 'unknown', true]
  ])('installs by hand on a missing plugin on a Hermes %s, with a restart: %s', (_title, reason, restart) => {
    expect(finishVariant(missing(reason), null)).toEqual({ kind: 'install', restart, failure: null, detail: null })
  })

  it('keeps the failure Hermes gave and still asks for the restart an old Hermes needs', () => {
    const manual: FinishManual = { failure: 'refused', detail: 'Plugin blocked by policy' }

    expect(finishVariant(missing('too_old'), manual)).toEqual({ kind: 'install', restart: true, failure: 'refused', detail: 'Plugin blocked by policy' })
    expect(finishVariant(missing(null), manual)).toEqual({ kind: 'install', restart: false, failure: 'refused', detail: 'Plugin blocked by policy' })
  })

  it('installs by hand for a refused enable, where the server lists the plugin turned off', () => {
    const manual: FinishManual = { failure: 'enable_refused', detail: 'enable refused: no' }

    expect(finishVariant({ kind: 'disabled', hermesVersion: '0.21.6' }, manual)).toEqual({ kind: 'install', restart: false, failure: 'enable_refused', detail: 'enable refused: no' })
  })

  it('shows the failure from the route before the first check has answered', () => {
    expect(finishVariant(null, { failure: 'no_git', detail: null })).toEqual({ kind: 'install', restart: false, failure: 'no_git', detail: null })
  })

  it('names no variant without a check and without a failure', () => {
    expect(finishVariant(null, null)).toBeNull()
  })

  it('asks for a restart when Hermes has the plugin but has not loaded it', () => {
    expect(finishVariant(waiting, null)).toEqual({ kind: 'restart' })
  })

  it('lets the server win over an old failure once the plugin is installed', () => {
    expect(finishVariant(waiting, { failure: 'scan_blocked', detail: null })).toEqual({ kind: 'restart' })
    expect(finishVariant(outdated('git install'), { failure: 'scan_blocked', detail: null })).toEqual({ kind: 'update' })
  })

  it.each<[InstallKind, FinishVariant]>([
    ['git install', { kind: 'update' }],
    ['manual copy', { kind: 'update_copy' }],
    ['deployment', { kind: 'deployment' }]
  ])('updates an outdated %s the way that kind of install is updated', (installKind, expected) => {
    expect(finishVariant(outdated(installKind), null)).toEqual(expected)
  })

  it.each<[string, ServerCheck]>([
    ['ready', ready],
    ['unknown', { kind: 'unknown' }],
    ['unavailable', { kind: 'unavailable', message: 'The store is busy.' }],
    ['app_outdated', { kind: 'app_outdated', health: FAKE_PLUGIN_HEALTH }],
    ['disabled', { kind: 'disabled', hermesVersion: '0.21.6' }]
  ])('names no variant for a %s check, so the screen keeps the one it had', (_title, check) => {
    expect(finishVariant(check, null)).toBeNull()
  })

  it('does not let a failure from the route replace the variant while the server cannot be reached or is ready', () => {
    const manual: FinishManual = { failure: 'refused', detail: null }

    expect(finishVariant({ kind: 'unknown' }, manual)).toBeNull()
    expect(finishVariant(ready, manual)).toBeNull()
  })

  it('takes the failure the setup screen passes in its route params', () => {
    const params = finishParams({ kind: 'manual', failure: 'download_failed', detail: null })

    expect(finishVariant(missing('untested'), manualFromParams(params ?? {}))).toEqual({ kind: 'install', restart: false, failure: 'download_failed', detail: null })
  })
})

describe('manualFromParams: the failure in the route', () => {
  it('reads a known failure with Hermes text', () => {
    const params: FinishParams = { failure: 'refused', detail: 'Plugin blocked by policy' }

    expect(manualFromParams(params)).toEqual({ failure: 'refused', detail: 'Plugin blocked by policy' })
  })

  it('reads a failure without text', () => {
    expect(manualFromParams({ failure: 'scan_blocked' })).toEqual({ failure: 'scan_blocked', detail: null })
    expect(manualFromParams({ failure: 'scan_blocked', detail: '' })).toEqual({ failure: 'scan_blocked', detail: null })
  })

  it('takes the first of a repeated parameter', () => {
    expect(manualFromParams({ failure: ['no_git', 'refused'], detail: ['first', 'second'] })).toEqual({ failure: 'no_git', detail: 'first' })
  })

  it.each<[string, Record<string, unknown>]>([
    ['no failure', {}],
    ['a failure the app does not know', { failure: 'format_c' }],
    ['a failure that is not text', { failure: 7 }],
    ['an empty list', { failure: [] }]
  ])('ignores %s', (_title, params) => {
    expect(manualFromParams(params)).toBeNull()
  })

  it('cuts a long text, so a link cannot fill the screen', () => {
    const manual = manualFromParams({ failure: 'refused', detail: 'x'.repeat(500) })

    expect(manual?.detail).toHaveLength(200)
  })
})

describe('finishView: the instructions for each variant', () => {
  it('shows the install command with the full commit and the guide for the manual steps', () => {
    const view = finishView(install(), buildRecord(), waiting)

    expect(view).toEqual({
      title: 'Finish on your server',
      intro: [RUN_INTRO],
      command: `hermes plugins install ${IDENTIFIER} --ref ${COMMIT} --enable`,
      restartLines: null,
      guide: { label: 'Open the guide', url: `${SERVER_GUIDE_URL}#manual` },
      status: 'Waiting for your server…',
      done: false,
      primary: { label: 'Check now', action: 'check' }
    })
    expect(view.command).toContain(COMMIT)
  })

  it('adds the restart lines to an install on a Hermes that does not load the plugin by itself', () => {
    const view = finishView(install({ restart: true }), buildRecord(), waiting)

    expect(view.restartLines).toEqual(RESTART_LINES)
    expect(RESTART_HEADING).toBe('Then restart Hermes:')
  })

  it('moves the pin of a git install with --force before --ref, and asks for the restart', () => {
    const view = finishView({ kind: 'update' }, buildRecord(), waiting)

    expect(view.title).toBe('Finish on your server')
    expect(view.intro).toEqual([RUN_INTRO])
    expect(view.command).toBe(`hermes plugins install ${IDENTIFIER} --force --ref ${COMMIT} --enable`)
    expect(view.restartLines).toEqual(RESTART_LINES)
    expect(view.guide).toEqual({ label: 'Open the guide', url: `${SERVER_GUIDE_URL}#manual` })
  })

  it('tells a manual copy to update its own folder to the version of this build, with no command', () => {
    const view = finishView({ kind: 'update_copy' }, buildRecord(), waiting)

    expect(view.intro).toEqual(['Update the folder you copied or linked the plugin from to version 0.2.0, then restart Hermes.'])
    expect(view.command).toBeNull()
    expect(view.restartLines).toEqual(RESTART_LINES)
    expect(view.guide.url).toBe(`${SERVER_GUIDE_URL}#manual`)
  })

  it('asks for a restart when Hermes has not loaded the plugin, with no command', () => {
    const view = finishView({ kind: 'restart' }, buildRecord(), waiting)

    expect(view.title).toBe('Finish on your server')
    expect(view.intro).toEqual(['Hermes has not loaded the Ergates plugin yet.'])
    expect(view.command).toBeNull()
    expect(view.restartLines).toEqual(RESTART_LINES)
    expect(view.guide).toEqual({ label: 'Open the guide', url: `${SERVER_GUIDE_URL}#restart` })
  })

  it('sends a deployment to update the deployment, with no command and no restart lines', () => {
    const view = finishView({ kind: 'deployment' }, buildRecord(), outdated('deployment'))

    expect(view.title).toBe('Update your Ergates deployment')
    expect(view.intro).toEqual(['This server runs the Ergates deployment, which brings its own plugin. Update the deployment to get plugin 0.2.0.'])
    expect(view.command).toBeNull()
    expect(view.restartLines).toBeNull()
    expect(view.guide).toEqual({ label: 'Open the guide', url: `${SERVER_GUIDE_URL}#deployment` })
  })

  it.each<[string, FinishVariant]>([
    ['an install', install()],
    ['an update', { kind: 'update' }]
  ])('shows no command for %s from a build without a commit, only the intro and the guide', (_title, variant) => {
    const view = finishView(variant, buildRecord(null), waiting)

    expect(view.command).toBeNull()
    expect(view.intro).toEqual([RUN_INTRO])
    expect(view.guide.url).toBe(`${SERVER_GUIDE_URL}#manual`)
    expect(view.status).toBe('Waiting for your server…')
  })

  it('shows no command without a build record, and names no version it does not know', () => {
    expect(finishView(install(), null, waiting).command).toBeNull()
    expect(finishView({ kind: 'update_copy' }, null, waiting).intro).toEqual(['Update the folder you copied or linked the plugin from to the newest version, then restart Hermes.'])
    expect(finishView({ kind: 'deployment' }, null, waiting).intro).toEqual(['This server runs the Ergates deployment, which brings its own plugin. Update the deployment to get the newest plugin.'])
  })
})

describe('finishView: why the install is by hand', () => {
  it.each<[string, FinishVariant, string]>([
    ['scan_blocked', install({ failure: 'scan_blocked' }), "Hermes's security check stopped the install. Run the command to see the findings."],
    ['no_git', install({ failure: 'no_git' }), 'Your server has no Git, which Hermes needs to install plugins. Install Git first.'],
    ['download_failed', install({ failure: 'download_failed' }), 'Your server could not download the plugin from GitHub.'],
    ['enable_refused', install({ failure: 'enable_refused', detail: 'enable refused: not allowed' }), 'Hermes refused the install: enable refused: not allowed'],
    ['refused', install({ failure: 'refused', detail: 'Plugin blocked by policy' }), 'Hermes refused the install: Plugin blocked by policy']
  ])('puts the reason for %s above the command', (_code, variant, reason) => {
    const view = finishView(variant, buildRecord(), waiting)

    expect(view.intro).toEqual([reason, RUN_INTRO])
    expect(view.command).toBe(`hermes plugins install ${IDENTIFIER} --ref ${COMMIT} --enable`)
  })

  it('says only that Hermes refused when it gave no text', () => {
    expect(finishView(install({ failure: 'refused' }), buildRecord(), waiting).intro[0]).toBe('Hermes refused the install.')
  })
})

describe('finishView: the status line and the button', () => {
  it('says it is checking before the first answer', () => {
    const view = finishView(install(), buildRecord(), null)

    expect(view.status).toBe('Checking…')
    expect(view.done).toBe(false)
    expect(view.primary).toEqual({ label: 'Check now', action: 'check' })
  })

  it.each<[string, ServerCheck]>([
    ['not loaded', waiting],
    ['outdated', outdated('git install')],
    ['unknown', { kind: 'unknown' }],
    ['missing', missing(null)]
  ])('keeps waiting while the check is %s', (_title, check) => {
    const view = finishView({ kind: 'restart' }, buildRecord(), check)

    expect(view.status).toBe('Waiting for your server…')
    expect(view.done).toBe(false)
    expect(view.primary).toEqual({ label: 'Check now', action: 'check' })
  })

  it('says the server is ready and leaves with Done, without the instructions it no longer needs', () => {
    const view = finishView(install({ restart: true }), buildRecord(), ready)

    expect(view).toMatchObject({ status: 'Your server is ready.', done: true, primary: { label: 'Done', action: 'done' }, intro: [], command: null, restartLines: null })
  })

  it('keeps the title of the variant it had when the server is ready', () => {
    expect(finishView({ kind: 'deployment' }, buildRecord(), ready).title).toBe('Update your Ergates deployment')
  })

  it('shows what went wrong with the setup of a ready server, and waits for the next check to try again', () => {
    const view = finishView({ kind: 'restart' }, buildRecord(), ready, 'The plugin could not set up your agents.')

    expect(view.status).toBe('The plugin could not set up your agents.')
    expect(view.done).toBe(false)
    expect(view.primary).toEqual({ label: 'Check now', action: 'check' })
  })

  it('ignores a setup problem while the server is not ready', () => {
    expect(finishView({ kind: 'restart' }, buildRecord(), waiting, 'Old problem').status).toBe('Waiting for your server…')
  })

  it('asks to sign in again after a restart, with the way to stay signed in', () => {
    const view = finishView({ kind: 'restart' }, buildRecord(), 'sign_in')

    expect(view.status).toBe(`Your server restarted. Sign in again to continue. ${SIGNED_OUT_HINT.text}`)
    expect(view.guide).toEqual({ label: 'How to stay signed in', url: `${SERVER_GUIDE_URL}#stay-signed-in` })
    expect(view.done).toBe(false)
    expect(view.primary).toEqual({ label: 'Sign in again', action: 'sign_in' })
    expect(view).toMatchObject({ intro: [], command: null, restartLines: null })
  })

  it('asks to sign in again before any variant is known', () => {
    const view = finishView(null, buildRecord(), 'sign_in')

    expect(view.title).toBe('Finish on your server')
    expect(view.primary.action).toBe('sign_in')
    expect(view.guide.url).toBe(SIGNED_OUT_HINT.url)
  })

  it('lets a sign-in win over a setup problem', () => {
    expect(finishView({ kind: 'restart' }, buildRecord(), 'sign_in', 'A problem').status).toContain('Sign in again to continue.')
  })

  it('shows only the title, the status and the guide before a variant is known', () => {
    expect(finishView(null, buildRecord(), null)).toEqual({
      title: 'Finish on your server',
      intro: [],
      command: null,
      restartLines: null,
      guide: { label: 'Open the guide', url: SERVER_GUIDE_URL },
      status: 'Checking…',
      done: false,
      primary: { label: 'Check now', action: 'check' }
    })
  })
})

describe('SIGNED_OUT_HINT: the sentence the sign-in screen shows too', () => {
  it('says why Hermes signs the user out and links to the guide for staying signed in', () => {
    expect(SIGNED_OUT_HINT).toEqual({
      text: 'Hermes signs you out when it restarts, unless your server has a fixed sign-in secret.',
      label: 'How to stay signed in',
      url: 'https://middelkamp.dev/ergates/server/#stay-signed-in'
    })
  })
})

describe('pendingCommit: when the screen records that the plugin is still to be set up', () => {
  it.each<[string, FinishVariant]>([
    ['an install', install()],
    ['an update', { kind: 'update' }],
    ['an update of a manual copy', { kind: 'update_copy' }]
  ])('records the commit of this build for %s', (_title, variant) => {
    expect(pendingCommit(variant, buildRecord())).toBe(COMMIT)
  })

  it.each<[string, FinishVariant | null]>([
    ['a restart', { kind: 'restart' }],
    ['a deployment', { kind: 'deployment' }],
    ['no variant yet', null]
  ])('records nothing for %s', (_title, variant) => {
    expect(pendingCommit(variant, buildRecord())).toBeNull()
  })

  it('records nothing without a commit', () => {
    expect(pendingCommit(install(), buildRecord(null))).toBeNull()
    expect(pendingCommit(install(), null)).toBeNull()
  })
})

describe('isSignedOut and setupProblem: what a failed call means', () => {
  it('knows the 401 of the gateway', () => {
    expect(isSignedOut(new GatewayError('unauthorized', 'Sign-in required.', { status: 401 }))).toBe(true)
  })

  it.each<[string, unknown]>([
    ['another gateway error', new GatewayError('network', 'Could not reach the gateway.')],
    ['an error from elsewhere', new Error('boom')],
    ['something that is not an error', 'unauthorized']
  ])('does not take %s for a sign-out', (_title, error) => {
    expect(isSignedOut(error)).toBe(false)
  })

  it('shows the message of a gateway error, which carries no secrets', () => {
    expect(setupProblem(new GatewayError('network', 'Could not reach the gateway.'))).toBe('Could not reach the gateway.')
  })

  it('shows a plain sentence for an error from elsewhere', () => {
    expect(setupProblem(new Error('boom'))).toBe('Could not set up your agents.')
  })
})
