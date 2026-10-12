/**
 * The line every screen shows in place when the plugin cannot do its job:
 * one value per kind of check, with the text and the screen that fixes it.
 */
import { describe, expect, it } from 'vitest'

import { FAKE_PLUGIN_HEALTH } from '@test/fake-gateway/fake-ergates'

import { MISSING_NOTICE, pluginNotice, pluginRowSubtitle } from './plugin-notice'
import type { ServerCheck } from './server-check'

const health = FAKE_PLUGIN_HEALTH

const ready: ServerCheck = { kind: 'ready', health }
const missing: ServerCheck = { kind: 'missing', hermesVersion: '0.21.6', oneTap: true, reason: null }
const disabled: ServerCheck = { kind: 'disabled', hermesVersion: '0.21.6' }
const notLoaded: ServerCheck = { kind: 'not_loaded', hermesVersion: '0.21.6' }
const outdated: ServerCheck = { kind: 'outdated', health, installKind: 'git install', hermesVersion: '0.21.6' }
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

  it('offers the Finish screen for a plugin that needs an update', () => {
    expect(pluginNotice(outdated)).toEqual({ text: 'The Ergates plugin on this server needs an update.', action: { label: 'Update', route: '/server/finish' } })
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

  it('shows the notice text for every kind that has one', () => {
    for (const check of [missing, disabled, notLoaded, outdated, appOutdated, unavailable]) {
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
