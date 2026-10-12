/**
 * A link from outside the app (a notification, another app, a web page, a QR
 * code) opens Home or the screen that routes a push link, and nothing else:
 * the server screens record that the plugin is to be set up and show text
 * beside a command, so only the app itself opens them, after a check of the
 * user's own server.
 *
 * Expo Router's own `extractExpoPathFromURL` is the oracle: it is the function
 * that turns what `externalPath` returns into the route the app opens, so the
 * route it gives for every link must be empty or `open`. The tests may import
 * that internal module; the app code must not.
 */
import { extractExpoPathFromURL } from 'expo-router/build/fork/extractPathFromURL'
import { describe, expect, it } from 'vitest'

import { externalPath } from './external-link'

/** The route Expo Router opens for what the app lets through. */
const routeOf = (link: string): string => extractExpoPathFromURL([], externalPath(link))
const opensNothingButHomeOrOpen = (route: string): boolean => route === '' || route.startsWith('open')

const wrapped = (inner: string, scheme = 'exp+ergates'): string => `${scheme}://expo-development-client/?url=${encodeURIComponent(inner)}`

/** Links to the server screens in the spellings that were tried: Expo Router opens `server/finish` for each of the first five without the allowlist. */
const SERVER_LINKS = [
  'ergates://user@server/finish',
  'ergates://:@server/finish',
  'ergates://server:/finish',
  'ergates://expo-development-client/?url=%2Fserver%2Ffinish',
  'exp+ergates://expo-development-client/?url=https%3A%2F%2Fx%2Fserver%2Ffinish'
]

const OTHER_SPELLINGS = [
  'ergates://server',
  'ergates://server/finish',
  'ergates://server/finish?failure=refused&detail=Run%20this%20instead',
  'ergates://server/finish#x',
  'ergates:///server/finish',
  'ergates:server/finish',
  'exp+ergates://server/finish',
  'ergates://server:8080/finish',
  'ergates://user:pass@server/finish',
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
  'https://middelkamp.dev/server/finish?failure=refused',
  'HTTPS://middelkamp.dev/server/finish',
  'http://127.0.0.1:8081/server/finish'
]

const MIXED_CASE_AND_ENCODED = [
  'ERGATES://SERVER/finish',
  'Ergates://Server/Finish',
  'ergates://expo-development-client/?url=%2FSERVER%2Ffinish',
  'ergates://Expo-Development-Client/?url=%2Fserver%2Ffinish',
  'ergates://expo-development-client/?url=%252Fserver%252Ffinish',
  'ergates://expo-development-client/?url=%2F%73erver%2Ffinish',
  'ergates://expo-development-client/?url=https%3A%2F%2Fx%2F%73erver%2Ffinish',
  'ergates://%73erver/%66inish'
]

const NESTED_WRAPPERS = [
  wrapped(wrapped('/server/finish')),
  wrapped(wrapped(wrapped('/server/finish'))),
  wrapped(wrapped('https://x/server/finish'), 'ergates'),
  wrapped('http://127.0.0.1:8081/server/finish'),
  wrapped('ergates://server/finish'),
  wrapped('ergates://user@server/finish'),
  wrapped(wrapped('ergates://:@server/finish'), 'ergates'),
  wrapped('ergates://chat/thijs'),
  wrapped('/settings')
]

const OPEN_LINKS = ['/open?connection=conn-1&profile=thijs&session=s1', 'ergates://open?connection=conn-1&profile=thijs', 'open?connection=conn-1']

const HOME_AND_LAUNCH_LINKS = [
  '',
  '/',
  'ergates://',
  'ergates:///',
  'http://127.0.0.1:8081',
  'http://192.168.1.5:8081/',
  'exp+ergates://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A8081',
  'exp+ergates://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A8081&disableOnboarding=1',
  'exp+ergates://expo-development-client/?url=http%3A%2F%2F192.168.1.5%3A8081%2F',
  'ergates://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A8081',
  'exp+ergates://expo-development-client/',
  'exp+ergates://expo-development-client/?url=',
  wrapped(wrapped('http://127.0.0.1:8081'))
]

describe('externalPath: the links that must not reach the server screens', () => {
  it.each([...SERVER_LINKS, ...OTHER_SPELLINGS, ...MIXED_CASE_AND_ENCODED, ...NESTED_WRAPPERS])('sends %j to Home', link => {
    expect(externalPath(link)).toBe('/')
  })

  it.each([...SERVER_LINKS, ...OTHER_SPELLINGS, ...MIXED_CASE_AND_ENCODED, ...NESTED_WRAPPERS])('leaves Expo Router with no route but Home or open for %j', link => {
    expect(opensNothingButHomeOrOpen(routeOf(link))).toBe(true)
  })

  it.each(SERVER_LINKS)('is a link Expo Router opens to the server screen without the guard: %j', link => {
    // Proves the oracle sees what the first five spellings do, so the checks above would catch a link that passes.
    expect(extractExpoPathFromURL([], link)).toBe('server/finish')
  })

  it('answers every combination of scheme, userinfo, host, port and tail with a route that is Home or open', () => {
    const schemes = ['ergates://', 'exp+ergates://', 'ERGATES://', 'ergates:', 'ergates:///', 'http://x', 'https://x', 'http://127.0.0.1:8081', 'HTTP://x', '', '/', '//', '///']
    const authorities = ['server', 'user@server', ':@server', 'server:', 'server:80', 'SERVER', '%73erver', 'x', 'expo-development-client', 'open', 'open@server']
    const tails = [
      '',
      '/',
      '/finish',
      '/finish?failure=refused&detail=x',
      '?url=%2Fserver%2Ffinish',
      '/?url=%2Fserver%2Ffinish',
      `/?url=${encodeURIComponent('ergates://server/finish')}`,
      `/?url=${encodeURIComponent('ergates://expo-development-client/?url=%2Fserver')}`,
      '/../server',
      '#x/server',
      '/%2e%2e/server'
    ]
    const links = schemes.flatMap(scheme => authorities.flatMap(authority => tails.map(tail => `${scheme}${authority}${tail}`)))

    const bad = links.filter(link => !opensNothingButHomeOrOpen(routeOf(link)))

    expect(links.length).toBeGreaterThan(1000)
    expect(bad).toEqual([])
  })

  it('answers without throwing for input it cannot read', () => {
    for (const link of ['\u0000', '\ud800', '%'.repeat(50), '/'.repeat(500), `/${'a/'.repeat(500)}server`, '?#', '://', '(', '/(/server', '/../../server', 'ergates://..', 'http://', 'https://[', '/%E0%A4%A']) {
      expect(() => externalPath(link)).not.toThrow()
      expect(opensNothingButHomeOrOpen(routeOf(link))).toBe(true)
    }
  })

  it('goes Home when the wrappers are nested deeper than anyone needs', () => {
    let link = '/server/finish'
    for (let level = 0; level < 20; level += 1) {
      link = wrapped(link)
    }

    expect(externalPath(link)).toBe('/')
  })
})

describe('externalPath: the links that stay as they are', () => {
  it.each(OPEN_LINKS)('lets the push link %j through, to the screen that routes it', link => {
    expect(externalPath(link)).toBe(link)
    expect(routeOf(link).startsWith('open')).toBe(true)
  })

  it.each(HOME_AND_LAUNCH_LINKS)('lets the link %j through, which opens Home', link => {
    expect(externalPath(link)).toBe(link)
    expect(routeOf(link)).toBe('')
  })

  it.each([
    '/settings',
    '/chat/thijs',
    'ergates://chat/thijs',
    'ergates://chat/s1?profile=thijs',
    'ergates://settings',
    'ergates://?x=1',
    'http://127.0.0.1:8081/?url=%2Fserver%2Ffinish',
    '/?url=%2Fserver%2Ffinish',
    '/servers',
    '/server-info',
    '/notifications?next=server',
    '/chat/server',
    'https://middelkamp.dev/ergates/server/',
    'ergates://serverless',
    'ergates://open/extra',
    'ergates://open@server/finish',
    '/open/extra',
    '/open#x'
  ])('sends the other screen %j to Home, because only Home and open are for outside links', link => {
    expect(externalPath(link)).toBe('/')
  })
})
