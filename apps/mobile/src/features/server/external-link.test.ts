/**
 * A link from outside the app (a notification, another app, a web page, a
 * QR code) never opens the server screens: they record that the plugin is
 * to be set up and show text beside a command, so only the app itself,
 * after a check of the user's own server, opens them.
 */
import { describe, expect, it } from 'vitest'

import { externalPath } from './external-link'

describe('externalPath', () => {
  it.each([
    'ergates://server',
    'ergates://server/finish',
    'ergates://server/finish?failure=refused&detail=Run%20this%20instead',
    'ergates://server/finish#x',
    'ergates:///server/finish',
    'ergates:server/finish',
    'exp+ergates://server/finish',
    '/server',
    '/server/',
    '/server/finish',
    '/server/finish?failure=refused',
    'server',
    'server/finish',
    '//server/finish',
    '///server/finish',
    '/SERVER/Finish',
    'ERGATES://Server/finish',
    '/%73erver/finish',
    'ergates://%53erver/finish',
    '/./server/finish',
    '/open/../server/finish',
    '/(group)/server/finish',
    '/server?x=1',
    '/server#x',
    '/ser\tver/finish',
    ' /server/finish',
    '\\server\\finish',
    '/%2Fserver/finish',
    'https://middelkamp.dev/server/finish?failure=refused'
  ])('sends %s to Home', path => {
    expect(externalPath(path)).toBe('/')
  })

  it.each([
    '/',
    '/settings',
    '/chat/thijs',
    '/open?connection=conn-1&profile=thijs&session=s1',
    'ergates://chat/s1?connection=conn-1&profile=thijs',
    'ergates://open?connection=conn-1',
    'exp+ergates://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A8081',
    'https://middelkamp.dev/ergates/server/',
    'https://server.example.com/settings',
    'ergates://chat/server',
    '/servers',
    '/server-info',
    '/notifications?next=server',
    '/chat/server',
    '/chat/thijs?profile=server/finish',
    'ergates://serverless',
    ''
  ])('leaves %s as it is', path => {
    expect(externalPath(path)).toBe(path)
  })

  it('does not throw on a path it cannot read', () => {
    expect(externalPath('/%E0%A4%A')).toBe('/%E0%A4%A')
    expect(externalPath('/%E0%A4%A/%73erver')).toBe('/%E0%A4%A/%73erver')
    expect(externalPath('/%73erver/%E0%A4%A')).toBe('/')
    expect(externalPath('ergates://%')).toBe('ergates://%')
  })
})

describe('externalPath on odd input', () => {
  it.each(['\u0000', '\ud800', '%'.repeat(50), '/'.repeat(500), `/${'a/'.repeat(500)}server`, '?#', '://', '(', '/(/server', '/../../server', 'ergates://..'])('answers without throwing for %j', path => {
    expect(() => externalPath(path)).not.toThrow()
  })

  it('reads dots above the root as the root', () => {
    expect(externalPath('/../../server')).toBe('/')
  })
})
