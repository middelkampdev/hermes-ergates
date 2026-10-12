/**
 * Links from outside the app open Home or the screen that routes a push link,
 * and nothing else. "Set up your server" and "Finish on your server" record
 * that the plugin is still to be set up and show text beside a command to run
 * on the user's server, so only the app itself opens them, after it checked
 * the user's own server. Any other app, web page or QR code could otherwise
 * send the user there.
 *
 * This is an allowlist on the route Expo Router derives from the link, not a
 * list of routes to keep out: a link has many spellings of the same route
 * (user info and an empty port before the host, a development client link that
 * carries another link in its `url`, percent-encoding, case), and a list of
 * the ones that are known misses the next. `routeOf` follows
 * `extractExpoPathFromURL` in expo-router (`fork/extractPathFromURL`), the
 * function that reads what `redirectSystemPath` returns, step by step and with
 * the same `URL`; a test runs that function itself over a corpus of links.
 *
 * It never throws: it runs before Expo Router matches a link and a throw
 * there can crash the launch. A link it cannot read goes Home.
 */

const DEV_CLIENT_HOST = 'expo-development-client'
/** How many development client links may carry one another. Expo Router follows them without end. */
const MAX_NESTING = 8

/** The routes a link from outside may open: Home (no route at all) and `open`, which takes a query. */
const ALLOWED_ROUTE = /^(?:open(?:\?[\s\S]*)?)?$/

function safeDecodeURI(value: string): string {
  try {
    return decodeURI(value)
  } catch {
    return value
  }
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/** A custom scheme: the route is the host and the path after it. */
function fromDeepLink(url: string, nesting: number): string {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    // Not a URL (a path, or a scheme that is not a valid one): Expo Router takes it as it is, or without its scheme.
    return url.startsWith('/') ? url : url.replace(/^[^:]+:\/\//, '')
  }
  if (parsed.hostname === DEV_CLIENT_HOST) {
    // The development client launcher: whatever scheme brought it, the route is that of its `url` parameter.
    const inner = parsed.searchParams.get('url')
    return inner ? exactPath(safeDecodeURI(inner), nesting + 1) : ''
  }
  const query = parsed.search
    ? [...parsed.searchParams.entries()].map(([key, value]) => `${key}=${safeDecodeURIComponent(value)}`).join('&')
    : ''
  return `${parsed.host}${parsed.pathname}${query ? `?${query}` : ''}`
}

function exactPath(url: string, nesting: number): string {
  if (nesting > MAX_NESTING) {
    throw new Error('Links nested too deep.')
  }
  if (/^https?:\/\//.test(url)) {
    // A web link: the route is its path, without the origin.
    const { origin, href, hostname } = new URL(url)
    return hostname === 'exp.host' || hostname === 'u.expo.dev' ? '' : href.replace(origin, '')
  }
  return fromDeepLink(url, nesting)
}

/** The route Expo Router opens for a link, as `extractExpoPathFromURL` gives it. Throws for a link it would not read either. */
function routeOf(url: string): string {
  return exactPath(url, 0).replace(/^\//, '')
}

/**
 * The link as it came when its route is Home (none) or `open` (what a push
 * link is rewritten to), else `/`. Run it on the link after the push link
 * rewrite. A development client launch link and a plain `http://127.0.0.1:8081`
 * have no route of their own, so they pass.
 */
export function externalPath(path: string): string {
  try {
    return ALLOWED_ROUTE.test(routeOf(path)) ? path : '/'
  } catch {
    return '/'
  }
}
