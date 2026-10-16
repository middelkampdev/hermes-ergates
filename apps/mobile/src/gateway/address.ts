/**
 * What a server address is, judged from the host the request will go to.
 * Pure functions, no network: the app cannot look up DNS before it connects,
 * so a name it cannot see through counts as public.
 */

export type AddressKind = 'loopback' | 'tailscale' | 'private' | 'public'

type Ipv4 = [number, number, number, number]
type Ipv6 = [number, number, number, number, number, number, number, number]

/** Name endings that stay on the local network. A name without a dot does too. */
const LOCAL_NAME_ENDINGS = ['.local', '.home.arpa', '.internal']
const TAILSCALE_NAME_ENDING = '.ts.net'
/** Anything outside printable ASCII. The app's URL parser does not convert Unicode hosts, the phone's network stack does. */
const NON_ASCII = /[^ -~]/
/** A scheme other than `http://` or `https://`, or one of them with a single slash: such an address is left as typed. */
const OTHER_SCHEME = /^[a-z][a-z0-9+.-]*:\//i
const HTTP_SCHEME = /^https?:\/\//i

/** Why the app does not connect to an address that may be on the public internet over plain `http`. */
export const PUBLIC_HTTP_REFUSAL = 'This address may be on the public internet without encryption. Ergates connects to a public server only over https.'

/**
 * The address as the app sends requests to it: trimmed, no trailing slash, `http://` when no scheme was
 * typed. The scheme is split off first, so slashes only count after it and `https://` stays `https://`.
 * Another scheme (`ftp://`, `ws://`), or `http:/` or `https:/` with one slash, is left as typed: with
 * `http://` in front, the scheme would read as a host without a dot. Such an address is graded public.
 */
export function normalizeBaseUrl(text: string): string {
  const trimmed = text.trim()
  const scheme = HTTP_SCHEME.exec(trimmed)?.[0]
  if (!scheme && OTHER_SCHEME.test(trimmed)) {
    return trimmed
  }
  const rest = trimmed.slice(scheme?.length ?? 0).replace(/\/+$/, '')
  return `${scheme ?? 'http://'}${rest}`
}

export function usesHttps(baseUrl: string): boolean {
  return /^https:\/\//i.test(normalizeBaseUrl(baseUrl))
}

/**
 * True when plain `http` to this address stays on a private network: loopback, a private address, or a
 * Tailscale IP address, which Tailscale encrypts. False for a public address and for a `*.ts.net` name,
 * which resolves through the local network's DNS when Tailscale is off and can be published by Funnel.
 */
export function allowsPlainHttp(baseUrl: string): boolean {
  const kind = addressKind(baseUrl)
  return kind === 'loopback' || kind === 'private' || (kind === 'tailscale' && !isTailscaleName(baseUrl))
}

/**
 * Loopback, Tailscale, private or public, judged by the host the request goes to.
 *
 * The URL parser rewrites some hosts (octal, hex and short IPv4 forms, plain integers, `%`-encoded and
 * Unicode dots), but the phone's network stack gets the address as typed and may read it as another
 * address: `012.0.0.1` is 10.0.0.1 to the parser and 12.0.0.1 to the phone. So a host is trusted only when
 * the text as typed (after the last `@`, before the port, in lower case, without a trailing dot) is what the
 * parser reads and is plain ASCII. Anything else is public, and so is an address with a user name or
 * password or one the parser cannot read. A bracketed IPv6 host is read by the parser. A host that ends in a
 * number but is not a plain dotted IPv4 address is public too, whatever the parser made of it.
 */
export function addressKind(baseUrl: string): AddressKind {
  const host = hostOf(baseUrl)
  if (host === null) {
    return 'public'
  }
  if (host.startsWith('[') && host.endsWith(']')) {
    const groups = parseIpv6(host.slice(1, -1))
    return groups ? ipv6Kind(groups) : 'public'
  }
  const octets = parseIpv4(host)
  if (octets) {
    return ipv4Kind(octets)
  }
  return endsInANumber(host) ? 'public' : nameKind(host)
}

/**
 * True when the address is a `*.ts.net` name. Tailscale Funnel can publish such a name on the open
 * internet, so it says nothing about where the server sits.
 */
export function isTailscaleName(baseUrl: string): boolean {
  const hostname = parsedHostname(baseUrl)
  return hostname !== null && hostname.endsWith(TAILSCALE_NAME_ENDING)
}

/** The parser's host with IPv6 brackets kept and a trailing dot dropped, or null when it cannot read the address. */
function parsedHostname(baseUrl: string): string | null {
  const url = parseUrl(normalizeBaseUrl(baseUrl))
  return url ? withoutTrailingDot(url.hostname) : null
}

function parseUrl(address: string): URL | null {
  try {
    return new URL(address)
  } catch {
    return null
  }
}

function withoutTrailingDot(host: string): string {
  return host.replace(/\.$/, '')
}

/**
 * The host with IPv6 brackets kept and a trailing dot dropped, or null when it cannot be trusted: the
 * parser cannot read the address, or the address has a user name or password, or the parser rewrote the host.
 * The parser also reads `\` as `/` and drops tabs and line breaks, which the phone's network stack may read
 * differently, so an address with one is not trusted either.
 */
function hostOf(baseUrl: string): string | null {
  const address = normalizeBaseUrl(baseUrl)
  if (!HTTP_SCHEME.test(address) || /[\\\s]/.test(address)) {
    return null
  }
  const url = parseUrl(address)
  if (url === null || url.username !== '' || url.password !== '') {
    return null
  }
  const hostname = withoutTrailingDot(url.hostname)
  if (hostname === '') {
    return null
  }
  if (hostname.startsWith('[')) {
    return hostname
  }
  // Checked before lower-casing: the Kelvin sign (U+212A) lower-cases to an ASCII `k`.
  const typed = typedHost(address)
  return !NON_ASCII.test(typed) && typed.toLowerCase() === hostname ? hostname : null
}

/** The host as typed: after the last `@` of the authority, before the port, without a trailing dot. */
function typedHost(address: string): string {
  const authority = address.replace(HTTP_SCHEME, '').split(/[/?#]/)[0]
  const afterUserinfo = authority.slice(authority.lastIndexOf('@') + 1)
  return withoutTrailingDot(afterUserinfo.split(':')[0])
}

/**
 * The WHATWG URL parser's "ends in a number": the last label is all digits or starts with `0x`. A parser reads
 * such a host as an IPv4 address, so it is never a plain name, even when the parser left it as typed.
 */
function endsInANumber(host: string): boolean {
  const last = host.slice(host.lastIndexOf('.') + 1)
  return /^\d+$/.test(last) || /^0x/i.test(last)
}

function parseIpv4(host: string): Ipv4 | null {
  const parts = host.split('.')
  if (parts.length !== 4 || !parts.every(part => /^\d{1,3}$/.test(part))) {
    return null
  }
  const octets = parts.map(Number)
  return octets.every(octet => octet <= 255) ? (octets as Ipv4) : null
}

function ipv4Kind([a, b]: Ipv4): AddressKind {
  if (a === 127) {
    return 'loopback'
  }
  if (a === 100 && b >= 64 && b <= 127) {
    return 'tailscale'
  }
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)) {
    return 'private'
  }
  return 'public'
}

/** The eight 16-bit groups of an IPv6 address, with `::` expanded. */
function parseIpv6(text: string): Ipv6 | null {
  const halves = text.split('::')
  if (halves.length > 2) {
    return null
  }
  const head = halves[0] ? halves[0].split(':') : []
  const tail = halves[1] ? halves[1].split(':') : []
  const missing = 8 - head.length - tail.length
  const compressed = halves.length === 2
  if (compressed ? missing < 1 : missing !== 0) {
    return null
  }
  const groups = [...head, ...new Array<string>(missing).fill('0'), ...tail]
  if (!groups.every(group => /^[0-9a-f]{1,4}$/i.test(group))) {
    return null
  }
  return groups.map(group => parseInt(group, 16)) as Ipv6
}

function ipv6Kind(groups: Ipv6): AddressKind {
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups
  const leadingZeros = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0
  if (leadingZeros && g5 === 0 && g6 === 0 && g7 === 1) {
    return 'loopback'
  }
  if (leadingZeros && g5 === 0xffff) {
    // ::ffff:a.b.c.d is the IPv4 address a.b.c.d.
    return ipv4Kind([g6 >> 8, g6 & 0xff, g7 >> 8, g7 & 0xff])
  }
  if (g0 === 0xfd7a && g1 === 0x115c && g2 === 0xa1e0) {
    return 'tailscale'
  }
  // fc00::/7 (unique local) and fe80::/10 (link local). The Tailscale range above sits inside the first.
  if ((g0 & 0xfe00) === 0xfc00 || (g0 & 0xffc0) === 0xfe80) {
    return 'private'
  }
  return 'public'
}

function nameKind(name: string): AddressKind {
  if (name === 'localhost') {
    return 'loopback'
  }
  if (name.endsWith(TAILSCALE_NAME_ENDING)) {
    return 'tailscale'
  }
  if (!name.includes('.') || LOCAL_NAME_ENDINGS.some(ending => name.endsWith(ending))) {
    return 'private'
  }
  return 'public'
}
