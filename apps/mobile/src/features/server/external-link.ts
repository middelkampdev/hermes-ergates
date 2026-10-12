/**
 * Links from outside the app never open the server screens. "Set up your
 * server" and "Finish on your server" record that the plugin is still to be
 * set up and show text beside a command to run on the user's server, so only
 * the app itself opens them, after it checked the user's own server. Any
 * other app, web page or QR code could otherwise send the user there.
 *
 * Pure and total: no React, no Expo, and it never throws, because it runs
 * before Expo Router matches a link and a throw there can crash the launch.
 */

/** `<scheme>:` with its `//` when it has one. */
const SCHEME = /^([a-z][a-z0-9+.-]*):(?:\/\/)?/i

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

/** The route segments of a path as Expo Router matches them: decoded, without `.`, groups and the query, with `..` applied. */
function routeSegments(path: string): string[] {
  const route = path.split(/[?#]/, 1)[0] ?? ''
  const decoded = route.split('/').map(decodeSegment).join('/')
  const segments: string[] = []
  for (const segment of decoded.split('/')) {
    if (segment === '..') {
      segments.pop()
    } else if (segment !== '' && segment !== '.' && !/^\(.*\)$/.test(segment)) {
      segments.push(segment)
    }
  }
  return segments
}

/** What the link can mean as a route: a custom scheme puts the route right after it, a web link after its host. */
function routes(path: string): string[] {
  const match = SCHEME.exec(path)
  if (match === null) {
    return [path]
  }
  const rest = path.slice(match[0].length)
  return /^https?$/i.test(match[1] ?? '') ? [rest, rest.replace(/^[^/?#]*/, '')] : [rest]
}

/**
 * `/` for a link whose route is `server` or below, in any spelling: with or
 * without the scheme or the leading slash, in any case, percent-encoded, with
 * dots or groups in front, with any query. Every other link comes back
 * unchanged.
 */
export function externalPath(path: string): string {
  // The URL parser drops tabs and line breaks anywhere, and control characters and spaces in front.
  const cleaned = path
    .replace(/[\t\n\r]/g, '')
    .replace(/^[\u0000- ]+/, '')
    .replace(/\\/g, '/')
  return routes(cleaned).some(route => routeSegments(route)[0]?.toLowerCase() === 'server') ? '/' : path
}
