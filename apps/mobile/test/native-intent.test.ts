/**
 * What the app does with a link from outside, end to end: the push link
 * rewrite first, then the allowlist. Expo Router's own `extractExpoPathFromURL`
 * says which route the app opens for what comes out.
 */
import { extractExpoPathFromURL } from 'expo-router/build/fork/extractPathFromURL'
import { describe, expect, it } from 'vitest'

import { redirectSystemPath } from '../app/+native-intent'

const redirect = (path: string, initial = false): string => redirectSystemPath({ path, initial })
const routeOf = (path: string): string => extractExpoPathFromURL([], redirect(path))

// A push link whose value holds a lone surrogate makes the rewrite throw, and the link is then not rewritten.
const UNREADABLE_PUSH_LINKS = ['http://chat/..\\server\\finish?connection=\ud800', 'chat/\ud800?connection=a://server/finish', 'ergates://chat/s1?connection=\udc00&profile=thijs']

describe('redirectSystemPath', () => {
  it('opens the chat of a push link through /open, not a chat named after its session', () => {
    expect(redirect('ergates://chat/session-1?connection=conn-1&profile=thijs')).toBe('/open?connection=conn-1&profile=thijs&session=session-1')
    expect(routeOf('ergates://chat/session-1?connection=conn-1&profile=thijs')).toBe('open?connection=conn-1&profile=thijs&session=session-1')
  })

  it.each(['exp+ergates://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A8081', 'http://127.0.0.1:8081', '/', ''])('lets the launch link %j through as it is', link => {
    expect(redirect(link, true)).toBe(link)
    expect(routeOf(link)).toBe('')
  })

  it.each([
    'ergates://server/finish?failure=refused&detail=Run%20this%20instead',
    'ergates://user@server/finish',
    'ergates://:@server/finish',
    'ergates://server:/finish',
    'ergates://expo-development-client/?url=%2Fserver%2Ffinish',
    'exp+ergates://expo-development-client/?url=https%3A%2F%2Fx%2Fserver%2Ffinish',
    '/server/finish',
    // A push link that lacks what the rewrite needs is an unknown chat, not a way in.
    'ergates://chat/s1?profile=thijs',
    'ergates://chat/thijs'
  ])('sends the link %j Home', link => {
    expect(redirect(link)).toBe('/')
    expect(routeOf(link)).toBe('')
  })

  it.each(UNREADABLE_PUSH_LINKS)('sends the push link %j that the rewrite cannot read Home, not the link as it came', link => {
    // Left as it came, Expo Router would open a screen that is neither Home nor open.
    const asItCame = extractExpoPathFromURL([], link)
    expect(asItCame === '' || asItCame.startsWith('open')).toBe(false)

    expect(redirect(link)).toBe('/')
    expect(routeOf(link)).toBe('')
  })
})
