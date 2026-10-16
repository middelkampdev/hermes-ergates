import { describe, expect, it } from 'vitest'

import { FAKE_PLUGIN_HEALTH } from '@test/fake-gateway/fake-ergates'

import { NOT_WATCHED, watchRestart } from './restart-watch'
import type { ServerCheck } from './server-check'

const ready: ServerCheck = { kind: 'ready', health: FAKE_PLUGIN_HEALTH, update: null, hermesVersion: null }
const waiting: ServerCheck = { kind: 'not_loaded', hermesVersion: '0.21.6' }
const restartNeeded: ServerCheck = { kind: 'restart_needed', health: FAKE_PLUGIN_HEALTH, hermesVersion: '0.21.6' }
const unavailable: ServerCheck = { kind: 'unavailable', message: 'The store is busy.' }

describe('watchRestart: the first sign that the server restarted', () => {
  const after = (checks: (ServerCheck | null)[], signedOut = false) => checks.reduce((watch, check) => watchRestart(watch, check, signedOut), NOT_WATCHED)

  it.each<[string, ServerCheck | null, boolean]>([
    ['a poll that could not reach the server', { kind: 'unknown' }, true],
    ['a poll that answered the old code', restartNeeded, false],
    ['a plugin Hermes has not loaded', waiting, false],
    ['an unavailable plugin', unavailable, false],
    ['a working plugin', ready, false],
    ['no answer yet', null, false]
  ])('reads %s on its own', (_title, check, seen) => {
    expect(after([check]).seen).toBe(seen)
  })

  it('reads a refused session as the server having restarted', () => {
    expect(after([restartNeeded], true).seen).toBe(true)
  })

  it.each<[string, ServerCheck]>([
    ['Hermes has not loaded the plugin', waiting],
    ['the plugin cannot open its data', unavailable]
  ])('reads the old code answering and then %s as the server having restarted', (_title, check) => {
    expect(after([restartNeeded, check]).seen).toBe(true)
    expect(after([restartNeeded, restartNeeded, check]).seen).toBe(true)
  })

  it('does not read a plugin that never answered with the old code as a restart', () => {
    expect(after([waiting, waiting, unavailable]).seen).toBe(false)
  })

  it('remembers that the old code answered across polls that say nothing', () => {
    expect(after([restartNeeded, null, waiting]).seen).toBe(true)
  })

  it('keeps the sign once seen, whatever the next poll says', () => {
    const seen = after([{ kind: 'unknown' }])

    expect(watchRestart(seen, waiting, false).seen).toBe(true)
    expect(watchRestart(seen, restartNeeded, false).seen).toBe(true)
    expect(watchRestart(seen, null, false).seen).toBe(true)
  })

  it('answers the watch it was given when a poll changes nothing, so a screen can tell', () => {
    const watching = after([restartNeeded])

    expect(watchRestart(watching, restartNeeded, false)).toBe(watching)
    expect(watchRestart(NOT_WATCHED, waiting, false)).toBe(NOT_WATCHED)
  })
})
