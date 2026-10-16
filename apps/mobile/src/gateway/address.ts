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

/** The address as the app sends requests to it: trimmed, no trailing slash, `http://` when no scheme was typed. */
export function normalizeBaseUrl(text: string): string {
  const trimmed = text.trim().replace(/\/+$/, '')
  return /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`
}

export function usesHttps(baseUrl: string): boolean {
  return /^https:\/\//i.test(normalizeBaseUrl(baseUrl))
}

/**
 * Loopback, Tailscale, private or public. The URL parser decides which host
 * the request goes to, so `user@host` tricks, odd IPv4 spellings and names that
 * only start like an address are judged by what they really are. An address
 * the parser cannot read is public.
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
  return octets ? ipv4Kind(octets) : nameKind(host)
}

/**
 * The host with IPv6 brackets kept and a trailing dot dropped, or null when the address is not a URL.
 * The URL parser reads `\` as `/` and drops tabs and line breaks. The phone's network stack may read
 * them differently and send the request to another host, so an address with one is not trusted.
 */
function hostOf(baseUrl: string): string | null {
  const address = normalizeBaseUrl(baseUrl)
  if (/[\\\s]/.test(address)) {
    return null
  }
  try {
    const hostname = new URL(address).hostname.replace(/\.$/, '')
    return hostname === '' ? null : hostname
  } catch {
    return null
  }
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
  if (name.endsWith('.ts.net')) {
    return 'tailscale'
  }
  if (!name.includes('.') || LOCAL_NAME_ENDINGS.some(ending => name.endsWith(ending))) {
    return 'private'
  }
  return 'public'
}
