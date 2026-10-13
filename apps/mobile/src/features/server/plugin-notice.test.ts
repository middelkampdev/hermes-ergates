/**
 * The line every screen shows in place when the plugin cannot do its job:
 * one value per kind of check, with the text and the screen that fixes it.
 */
import { describe, expect, it } from 'vitest'

import { FAKE_PLUGIN_HEALTH } from '@test/fake-gateway/fake-ergates'

import { GatewayError } from '@/gateway/errors'

import { CHECKING_NOTICE, featureNotice, isBareNotFound, MISSING_NOTICE, noticeForError, pluginNotice, pluginRowSubtitle, recheckState, shouldReloadAfterNotice, updateLine } from './plugin-notice'
import type { UpdateOffer } from './plugin-version'
import type { ServerCheck } from './server-check'

const health = FAKE_PLUGIN_HEALTH

const offer: UpdateOffer = { from: '0.2.0', to: '0.3.0', commit: 'b'.repeat(40), previous: 'a'.repeat(40), previousSchema: 2 }

const ready: ServerCheck = { kind: 'ready', health, update: null, hermesVersion: null }
const readyWithUpdate: ServerCheck = { kind: 'ready', health, update: offer, hermesVersion: '0.21.6' }
const restartNeeded: ServerCheck = { kind: 'restart_needed', health, hermesVersion: '0.21.6' }
const missing: ServerCheck = { kind: 'missing', hermesVersion: '0.21.6', oneTap: true, reason: null }
const disabled: ServerCheck = { kind: 'disabled', hermesVersion: '0.21.6' }
const notLoaded: ServerCheck = { kind: 'not_loaded', hermesVersion: '0.21.6' }
const outdated: ServerCheck = { kind: 'outdated', health, installKind: 'git install', update: null, hermesVersion: '0.21.6' }
const outdatedWithUpdate: ServerCheck = { kind: 'outdated', health, installKind: 'git install', update: offer, hermesVersion: '0.21.6' }
const appOutdated: ServerCheck = { kind: 'app_outdated', health }
const unavailable: ServerCheck = { kind: 'unavailable', message: 'The store is locked.' }

describe('pluginNotice', () => {
  it('says nothing while the plugin is ready, unknown or not read yet', () => {
    expect(pluginNotice(ready)).toBeNull()
    expect(pluginNotice({ kind: 'unknown' })).toBeNull()
    expect(pluginNotice(undefined)).toBeNull()
  })

  it('offers the setup screen for a plugin that is missing', () => {
    expect(pluginNotice(missing)).toEqual({ text: 'Ergates is not set up on this server.', action: { label: 'Set up', route: '/server' } })
  })

  it('says the same for a missing plugin whatever the reason it needs a manual install', () => {
    expect(pluginNotice({ kind: 'missing', hermesVersion: null, oneTap: false, reason: 'no_commit' })).toEqual(pluginNotice(missing))
  })

  it('offers the setup screen for a plugin that is turned off', () => {
    expect(pluginNotice(disabled)).toEqual({ text: 'The Ergates plugin is turned off on this server.', action: { label: 'Turn on', route: '/server' } })
  })

  it('offers the Finish screen for a plugin Hermes has not loaded', () => {
    expect(pluginNotice(notLoaded)).toEqual({ text: 'Hermes has not loaded the Ergates plugin yet.', action: { label: 'Show me how', route: '/server/finish' } })
  })

  it('offers the Finish screen for a plugin that needs an update the app cannot make', () => {
    expect(pluginNotice(outdated)).toEqual({ text: 'The Ergates plugin on this server needs an update.', action: { label: 'Update', route: '/server/finish' } })
  })

  it('offers the update itself for a plugin that needs one the app can make', () => {
    expect(pluginNotice(outdatedWithUpdate)).toEqual({ text: 'The Ergates plugin on this server needs an update.', action: { label: 'Update', route: '/server/update' } })
  })

  it('asks for a restart of Hermes once the update is installed', () => {
    expect(pluginNotice(restartNeeded)).toEqual({ text: 'Restart Hermes to finish the plugin update.', action: { label: 'Show me how', route: '/server/finish' } })
  })

  it('says nothing about a working plugin that has an optional update, which is a line of its own', () => {
    expect(pluginNotice(readyWithUpdate)).toBeNull()
  })

  it('tells the user to update the app when the plugin is newer, with nothing to tap', () => {
    expect(pluginNotice(appOutdated)).toEqual({ text: "This server's Ergates plugin needs a newer version of this app. Update Ergates.", action: null })
  })

  it('passes the server own message on when the plugin cannot open its data, with nothing to tap', () => {
    expect(pluginNotice(unavailable)).toEqual({ text: 'The Ergates plugin cannot open its data on this server: The store is locked.', action: null })
  })

  it('has one missing notice for the places that only know a route was not found', () => {
    expect(MISSING_NOTICE).toEqual(pluginNotice(missing))
  })
})

describe('pluginRowSubtitle', () => {
  it('shows the plugin version when it is ready', () => {
    expect(pluginRowSubtitle(ready, false)).toBe(health.plugin_version)
  })

  it('names the update next to the version when a working plugin has one ready', () => {
    expect(pluginRowSubtitle(readyWithUpdate, false)).toBe(`${health.plugin_version} (update to ${offer.to} ready)`)
  })

  it('shows the notice, not the offer, for a plugin that needs the update', () => {
    expect(pluginRowSubtitle(outdatedWithUpdate, false)).toBe(pluginNotice(outdatedWithUpdate)?.text)
  })

  it('shows the notice text for every kind that has one', () => {
    for (const check of [missing, disabled, notLoaded, restartNeeded, outdated, outdatedWithUpdate, appOutdated, unavailable]) {
      expect(pluginRowSubtitle(check, false)).toBe(pluginNotice(check)?.text)
    }
  })

  it('says it is checking until the first answer, and that it could not check when none came', () => {
    expect(pluginRowSubtitle(undefined, false)).toBe('Checking…')
    expect(pluginRowSubtitle(undefined, true)).toBe('Could not check')
    expect(pluginRowSubtitle({ kind: 'unknown' }, false)).toBe('Could not check')
  })

  it('keeps the last answer when a later check fails', () => {
    expect(pluginRowSubtitle(ready, true)).toBe(health.plugin_version)
  })
})

describe('updateLine', () => {
  it('offers the update of a plugin that works', () => {
    expect(updateLine(readyWithUpdate)).toEqual({ text: 'An update for the Ergates plugin is ready.', action: { label: 'Update', route: '/server/update' } })
  })

  it('says nothing for a working plugin without an update', () => {
    expect(updateLine(ready)).toBeNull()
  })

  it('leaves a plugin that needs an update to its notice, which has the same button', () => {
    expect(updateLine(outdatedWithUpdate)).toBeNull()
  })

  it.each([
    ['restart_needed', restartNeeded],
    ['missing', missing],
    ['disabled', disabled],
    ['not_loaded', notLoaded],
    ['outdated', outdated],
    ['app_outdated', appOutdated],
    ['unavailable', unavailable],
    ['unknown', { kind: 'unknown' }],
    ['no check yet', undefined]
  ] as [string, ServerCheck | undefined][])('says nothing for a check that is %s', (_title, check) => {
    expect(updateLine(check)).toBeNull()
  })
})

describe('noticeForError', () => {
  const notice = pluginNotice(missing)

  it('keeps the notice for an error the plugin can cause', () => {
    for (const error of [new GatewayError('not_found', 'Not Found', { status: 404 }), new GatewayError('unknown', 'Something broke.'), new GatewayError('forbidden', 'No.'), new Error('plain')]) {
      expect(noticeForError(notice, error)).toBe(notice)
    }
  })

  it('leaves a lost connection, a timeout and a refused session to their own message', () => {
    for (const kind of ['network', 'timeout', 'unauthorized'] as const) {
      expect(noticeForError(notice, new GatewayError(kind, 'x'))).toBeNull()
    }
  })

  it('has nothing to show without a notice', () => {
    expect(noticeForError(null, new GatewayError('not_found', 'Not Found', { status: 404 }))).toBeNull()
  })
})

describe('isBareNotFound', () => {
  it('is a 404 without an Ergates code: the route itself is missing', () => {
    expect(isBareNotFound(new GatewayError('not_found', 'Not found on the gateway.', { status: 404 }))).toBe(true)
  })

  it('is not a record the plugin did not find, a session Hermes no longer holds, or any other error', () => {
    expect(isBareNotFound(new GatewayError('not_found', 'No such proposal.', { status: 404, code: 'not_found' }))).toBe(false)
    expect(isBareNotFound(new GatewayError('not_found', 'session not found', { code: 4007 }))).toBe(false)
    expect(isBareNotFound(new GatewayError('network', 'No connection to the gateway.'))).toBe(false)
    expect(isBareNotFound(new Error('Not found'))).toBe(false)
    expect(isBareNotFound(null)).toBe(false)
  })
})

describe('featureNotice: a feature whose route is missing while the cached check says ready', () => {
  const missingRoute = new GatewayError('not_found', 'Not found on the gateway.', { status: 404 })
  const quiet = { notice: null, checking: false, recheck: false }
  const checking = { notice: CHECKING_NOTICE, checking: true }

  it('asks the check again once, and says it is checking', () => {
    expect(featureNotice(ready, missingRoute, 'not_asked')).toEqual({ ...checking, recheck: true })
  })

  it('keeps saying it is checking, without asking again, until the fresh check answers', () => {
    expect(featureNotice(ready, missingRoute, 'asking')).toEqual({ ...checking, recheck: false })
    expect(CHECKING_NOTICE).toEqual({ text: 'Checking your server…', action: null })
  })

  it('shows the notice of the fresh check once it found the plugin off, missing or not loaded', () => {
    expect(featureNotice(disabled, missingRoute, 'answered')).toEqual({ notice: pluginNotice(disabled), checking: false, recheck: false })
    expect(featureNotice(missing, missingRoute, 'asking')).toEqual({ notice: MISSING_NOTICE, checking: false, recheck: false })
    expect(featureNotice(notLoaded, missingRoute, 'not_asked')).toEqual({ notice: pluginNotice(notLoaded), checking: false, recheck: false })
  })

  it('shows the restart notice when a feature fails while the plugin waits for a restart', () => {
    expect(featureNotice(restartNeeded, missingRoute, 'not_asked')).toEqual({ notice: pluginNotice(restartNeeded), checking: false, recheck: false })
  })

  it("leaves the feature its own error when the fresh check still says ready, and does not ask again", () => {
    expect(featureNotice(ready, missingRoute, 'answered')).toEqual(quiet)
  })

  it('does nothing extra for any other error, or for no error', () => {
    const pruned = new GatewayError('not_found', 'No such proposal.', { status: 404, code: 'not_found' })

    expect(featureNotice(ready, pruned, 'not_asked')).toEqual(quiet)
    expect(featureNotice(ready, new GatewayError('network', 'No connection to the gateway.'), 'not_asked')).toEqual(quiet)
    expect(featureNotice(ready, null, 'not_asked')).toEqual(quiet)
    expect(featureNotice(disabled, undefined, 'not_asked')).toEqual({ notice: pluginNotice(disabled), checking: false, recheck: false })
  })

  it('does not ask before the check has answered at all, or when it could not tell', () => {
    expect(featureNotice(undefined, missingRoute, 'not_asked')).toEqual(quiet)
    expect(featureNotice({ kind: 'unknown' }, missingRoute, 'not_asked')).toEqual(quiet)
  })
})

describe('recheckState', () => {
  const error = new GatewayError('not_found', 'Not found on the gateway.', { status: 404 })

  it('has not asked for an error before it asks', () => {
    expect(recheckState(null, error, 1_000)).toBe('not_asked')
  })

  it('has not asked for a new error, even after it asked for an earlier one', () => {
    const earlier = new GatewayError('not_found', 'Not found on the gateway.', { status: 404 })

    expect(recheckState({ error: earlier, after: 1_000 }, error, 2_000)).toBe('not_asked')
  })

  it('is asking until the check answers or fails after the moment it asked', () => {
    expect(recheckState({ error, after: 1_000 }, error, 1_000)).toBe('asking')
    expect(recheckState({ error, after: 1_000 }, error, 1_001)).toBe('answered')
  })
})

describe('shouldReloadAfterNotice', () => {
  const failed = new GatewayError('not_found', 'Not Found', { status: 404 })

  it('reloads once the notice that explained the failed read is gone', () => {
    expect(shouldReloadAfterNotice(true, false, failed)).toBe(true)
  })

  it('does not reload while the notice stays, appears for the first time, or was never there', () => {
    expect(shouldReloadAfterNotice(true, true, failed)).toBe(false)
    expect(shouldReloadAfterNotice(false, true, failed)).toBe(false)
    expect(shouldReloadAfterNotice(false, false, failed)).toBe(false)
  })

  it('does not reload a read that went through', () => {
    expect(shouldReloadAfterNotice(true, false, null)).toBe(false)
    expect(shouldReloadAfterNotice(true, false, undefined)).toBe(false)
  })
})
