import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { URL as RuntimeUrl } from 'whatwg-url-minimum'

import { addressKind, allowsPlainHttp, isTailscaleName, normalizeBaseUrl, PUBLIC_HTTP_REFUSAL, usesHttps, type AddressKind } from './address'

type Row = [address: string, kind: AddressKind]

const LOOPBACK: Row[] = [
  ['http://127.0.0.1:9119', 'loopback'],
  ['http://127.255.255.254', 'loopback'],
  ['http://localhost:9119', 'loopback'],
  ['http://localhost.', 'loopback'],
  ['http://[::1]:9119', 'loopback']
]

const TAILSCALE: Row[] = [
  ['http://100.64.0.1:9119', 'tailscale'],
  ['http://100.127.255.254', 'tailscale'],
  ['https://hermes.tail1234.ts.net', 'tailscale'],
  ['https://hermes.tail1234.ts.net.', 'tailscale'],
  ['http://[fd7a:115c:a1e0::1]:9119', 'tailscale'],
  ['http://[fd7a:115c:a1e0:ab12:4843:cd96:6200:1]', 'tailscale']
]

const PRIVATE: Row[] = [
  ['http://10.1.2.3', 'private'],
  ['http://172.16.0.1', 'private'],
  ['http://172.31.255.255', 'private'],
  ['http://192.168.1.10:9119', 'private'],
  ['http://169.254.1.1', 'private'],
  ['http://[fe80::1]', 'private'],
  ['http://[febf::1]', 'private'],
  ['http://[fd00::1]', 'private'],
  ['http://[fc00::1]', 'private'],
  ['http://hermes.local', 'private'],
  ['http://HERMES.LOCAL', 'private'],
  ['http://hermes.local.', 'private'],
  ['http://hermes', 'private'],
  ['http://nas.home.arpa', 'private'],
  ['http://box.internal', 'private']
]

const PUBLIC: Row[] = [
  ['https://203.0.113.10', 'public'],
  ['https://hermes.example.com', 'public'],
  ['http://100.128.0.1', 'public'],
  ['http://100.63.255.255', 'public'],
  ['http://172.32.0.1', 'public'],
  ['http://172.15.255.255', 'public'],
  ['http://192.169.0.1', 'public'],
  ['http://169.253.0.1', 'public'],
  ['http://11.0.0.1', 'public'],
  ['http://[fec0::1]', 'public'],
  ['http://[2001:db8::1]', 'public'],
  ['https://ts.net', 'public'],
  ['https://nottailscale.net', 'public']
]

describe('addressKind', () => {
  it.each(LOOPBACK)('%s is loopback', (address, kind) => {
    expect(addressKind(address)).toBe(kind)
  })

  it.each(TAILSCALE)('%s is tailscale', (address, kind) => {
    expect(addressKind(address)).toBe(kind)
  })

  it.each(PRIVATE)('%s is private', (address, kind) => {
    expect(addressKind(address)).toBe(kind)
  })

  it.each(PUBLIC)('%s is public', (address, kind) => {
    expect(addressKind(address)).toBe(kind)
  })

  it('classifies an IPv6 address next to the Tailscale range as private', () => {
    expect(addressKind('http://[fd7a:115c:a1e1::1]')).toBe('private')
  })
})

/** Hosts judged by where the request goes: look-alike names, the host after the `@`, IPv4-mapped IPv6 addresses and case. */
const BY_HOST: Row[] = [
  // The name only starts like a Tailscale address.
  ['http://100.64.0.1.example.com', 'public'],
  ['http://10.0.0.1.nip.io', 'public'],
  ['http://127.0.0.1.example.com', 'public'],
  // The host is what follows the @, whatever comes before it.
  ['http://10.0.0.1@evil.example', 'public'],
  ['http://localhost@evil.example', 'public'],
  ['http://user:pass@192.168.1.10@evil.example', 'public'],
  // An IPv4-mapped IPv6 address is the IPv4 address inside it, in any spelling the parser reads.
  ['http://[::ffff:8.8.8.8]', 'public'],
  ['http://[::ffff:10.0.0.1]', 'private'],
  ['http://[::ffff:127.0.0.1]', 'loopback'],
  ['http://[::ffff:100.64.0.1]', 'tailscale'],
  ['http://[::FFFF:7F00:1]:9119', 'loopback'],
  // Scheme and host are not case sensitive.
  ['HTTP://LOCALHOST', 'loopback']
]

/** Hosts the parser leaves as typed apart from case and a trailing dot. */
const KEPT_AS_TYPED: Row[] = [
  ['http://hermes.local.', 'private'],
  ['http://HERMES.Local:9119/', 'private'],
  ['http://127.0.0.1.:9119', 'loopback']
]

/**
 * The URL parser rewrites these hosts, or reads Unicode the phone's network stack converts, so the phone may read them as
 * another address: 012.0.0.1 is 10.0.0.1 to the parser and 12.0.0.1 to the phone. Only a plain ASCII host that the parser
 * leaves as typed is trusted. The Kelvin sign (U+212A) is not ASCII, but it lower-cases to an ASCII k.
 */
const READ_DIFFERENTLY = [
  'http://012.0.0.1',
  'http://0177.0.0.1',
  'http://0144.0100.0.1',
  'http://172%2e037%2e0%2e1',
  'http://172\u3002037\u30020\u30021',
  'http://0x7f.1',
  'http://0xC0A80001',
  'http://2130706433',
  'http://127.1',
  'http://hermes%2elocal',
  'http://hermes\u3002local',
  'http://b\u00fccher',
  'http://\uff4c\uff4f\uff43\uff41\uff4c\uff48\uff4f\uff53\uff54',
  'http://\u212Aelvin.local',
  'http://\u212A'
]

/**
 * Hosts whose last label is all digits or starts with `0x`: a WHATWG URL parser reads them as an IPv4 address ("ends in a
 * number"), so they are never a plain name, whether or not the parser rewrote them.
 */
const ENDS_IN_A_NUMBER = ['http://134744072', 'http://10.0x1', 'http://1.2.3.0x4', 'http://0x7f000001', 'http://0x', 'http://hermes.123', 'http://hermes.0x1', 'http://HERMES.0X1.']

/** An address with a user name or password is not a plain host, whatever host follows. */
const WITH_USERINFO = ['http://user@10.0.0.1', 'http://user:pass@192.168.1.10', 'http://user:pass@localhost:9119', 'http://:pass@hermes.local']

const UNREADABLE = ['', '   ', 'http://:9119', 'http://100.64.0.1.2', 'http://exa mple.com', 'http://[::1']

/**
 * The URL parser reads `\` as `/` and drops tabs and line breaks, so it would call these private. A phone's network stack
 * may read them differently and send the request to the host after the `@`.
 */
const READ_APART = ['http://192.168.1.10\\@evil.example', 'http://192.168.1.\t10', 'http://evil.example\n.local']

/** Another scheme, or a scheme with one slash: never an http address, so never a host after `http://`. */
const OTHER_SCHEMES = ['ftp://hermes', 'FTP://hermes', 'ws://192.168.1.10:9119', 'wss://hermes.local', 'file:///etc/hosts', 'https:/hermes', 'http:/192.168.1.10']

describe('addressKind judges by the host the request goes to', () => {
  it.each(BY_HOST)('%s is %s', (address, kind) => {
    expect(addressKind(address)).toBe(kind)
  })

  it.each(READ_DIFFERENTLY)('treats %j, which the phone may read differently from the URL parser, as public', address => {
    expect(addressKind(address)).toBe('public')
  })

  it.each(ENDS_IN_A_NUMBER)('treats %j, which ends in a number, as public', address => {
    expect(addressKind(address)).toBe('public')
  })

  it.each(WITH_USERINFO)('treats %j, which carries a user name or password, as public', address => {
    expect(addressKind(address)).toBe('public')
  })

  it.each(KEPT_AS_TYPED)('keeps %s, which the parser leaves as typed apart from case and a trailing dot, as %s', (address, kind) => {
    expect(addressKind(address)).toBe(kind)
  })

  it.each(UNREADABLE)('treats %j, which the URL parser cannot read, as public', address => {
    expect(addressKind(address)).toBe('public')
  })

  it.each(READ_APART)('treats %j, which the URL parser and the network stack may read differently, as public', address => {
    expect(addressKind(address)).toBe('public')
  })

  it.each(OTHER_SCHEMES)('treats %j, which is not an http or https address, as public', address => {
    expect(addressKind(address)).toBe('public')
  })
})

/**
 * A URL parser that reads no IPv4 forms and leaves every host as typed, in lower case. The rule for hosts that end in a
 * number must hold for any parser, not only for one that rewrites them.
 */
class AsTypedUrl {
  readonly hostname: string
  readonly username = ''
  readonly password = ''

  constructor(text: string) {
    const host = /^https?:\/\/([^/?#@:]+)/i.exec(text)?.[1]
    if (!host) {
      throw new TypeError('Invalid URL')
    }
    this.hostname = host.toLowerCase()
  }
}

describe('addressKind with a URL parser that leaves every host as typed', () => {
  const nodeUrl = globalThis.URL
  beforeAll(() => {
    globalThis.URL = AsTypedUrl as unknown as typeof URL
  })
  afterAll(() => {
    globalThis.URL = nodeUrl
  })

  it.each(ENDS_IN_A_NUMBER)('treats %j, which ends in a number, as public', address => {
    expect(addressKind(address)).toBe('public')
  })

  it.each<Row>([
    ['http://hermes', 'private'],
    ['http://hermes.local', 'private'],
    ['http://10.1.2.3', 'private'],
    ['http://localhost', 'loopback'],
    ['http://hermes.example.com', 'public']
  ])('still reads %s as %s', (address, kind) => {
    expect(addressKind(address)).toBe(kind)
  })
})

describe('addressKind with the runtime URL parser', () => {
  // On the phone, Expo installs whatwg-url-minimum as the global URL (expo/src/winter/url.ts). Node has its own parser.
  const nodeUrl = globalThis.URL
  beforeAll(() => {
    globalThis.URL = RuntimeUrl as unknown as typeof URL
  })
  afterAll(() => {
    globalThis.URL = nodeUrl
  })

  it('is the runtime parser while these tests run', () => {
    expect(new URL('http://x').constructor).toBe(RuntimeUrl)
  })

  it.each<Row>([...LOOPBACK, ...TAILSCALE, ...PRIVATE, ...PUBLIC, ...BY_HOST, ...KEPT_AS_TYPED])('%s is %s', (address, kind) => {
    expect(addressKind(address)).toBe(kind)
  })

  it.each([...READ_DIFFERENTLY, ...ENDS_IN_A_NUMBER, ...WITH_USERINFO, ...UNREADABLE, ...READ_APART, ...OTHER_SCHEMES])('treats %j as public', address => {
    expect(addressKind(address)).toBe('public')
  })
})

describe('the URL parser after the runtime parser tests', () => {
  it('is Node\'s own again', () => {
    expect(new URL('http://x')).toBeInstanceOf(URL)
    expect(URL).not.toBe(RuntimeUrl)
  })
})

describe('an address typed without a scheme', () => {
  it('gets http and is classified', () => {
    expect(normalizeBaseUrl('100.64.0.1:9119')).toBe('http://100.64.0.1:9119')
    expect(addressKind('100.64.0.1:9119')).toBe('tailscale')
  })

  it('is classified like the same address with http in front', () => {
    expect(addressKind('192.168.1.10:9119')).toBe('private')
    expect(addressKind('hermes.example.com')).toBe('public')
    expect(addressKind('[::1]:9119')).toBe('loopback')
  })

  it('ignores spaces around the address and a trailing slash', () => {
    expect(addressKind('  http://10.1.2.3:9119/  ')).toBe('private')
  })
})

describe('isTailscaleName', () => {
  it.each<[string, boolean]>([
    ['https://hermes.tail1234.ts.net', true],
    ['https://hermes.tail1234.ts.net.', true],
    ['HTTPS://HERMES.TAIL1234.TS.NET:8443', true],
    ['hermes.tail1234.ts.net', true],
    ['http://100.64.0.1', false],
    ['http://[fd7a:115c:a1e0::1]', false],
    ['http://evilts.net', false],
    ['http://ts.net', false],
    ['http://hermes.ts.net.example.com', false],
    ['http://hermes.local', false],
    ['', false]
  ])('%j gives %s', (address, expected) => {
    expect(isTailscaleName(address)).toBe(expected)
  })
})

describe('usesHttps', () => {
  it.each<[string, boolean]>([
    ['https://x', true],
    ['HTTPS://x', true],
    ['  https://x/  ', true],
    ['http://x', false],
    ['HTTP://x', false],
    ['x', false],
    ['x.example.com:443', false],
    ['', false]
  ])('%j gives %s', (address, expected) => {
    expect(usesHttps(address)).toBe(expected)
  })
})

describe('normalizeBaseUrl', () => {
  it('trims the text, drops trailing slashes and adds http when there is no scheme', () => {
    expect(normalizeBaseUrl(' 127.0.0.1:9119/ ')).toBe('http://127.0.0.1:9119')
    expect(normalizeBaseUrl('hermes.example.com//')).toBe('http://hermes.example.com')
  })

  it('keeps the scheme it was given', () => {
    expect(normalizeBaseUrl('https://gw.tail.net')).toBe('https://gw.tail.net')
    expect(normalizeBaseUrl('HTTPS://gw.tail.net/')).toBe('HTTPS://gw.tail.net')
    expect(normalizeBaseUrl('http://gw.tail.net')).toBe('http://gw.tail.net')
  })

  it('never eats a scheme that was typed without a host after it', () => {
    expect(normalizeBaseUrl('https://')).toBe('https://')
    expect(normalizeBaseUrl('http://')).toBe('http://')
    expect(normalizeBaseUrl('  HTTPS://  ')).toBe('HTTPS://')
    expect(normalizeBaseUrl('https:///')).toBe('https://')
  })

  it('leaves an address with another scheme, or a scheme with one slash, as typed, so it never reads as an http host', () => {
    expect(normalizeBaseUrl('ftp://hermes')).toBe('ftp://hermes')
    expect(normalizeBaseUrl(' ws://192.168.1.10:9119 ')).toBe('ws://192.168.1.10:9119')
    expect(normalizeBaseUrl('https:/hermes')).toBe('https:/hermes')
    expect(normalizeBaseUrl('ftp://')).toBe('ftp://')
  })

  it('still reads a name or an address with a port as one typed without a scheme', () => {
    expect(normalizeBaseUrl('localhost:9119')).toBe('http://localhost:9119')
    expect(normalizeBaseUrl('hermes.local:9119/')).toBe('http://hermes.local:9119')
    expect(normalizeBaseUrl('[::1]:9119')).toBe('http://[::1]:9119')
  })

  it('reads an empty or slash-only text as http with no host', () => {
    expect(normalizeBaseUrl('')).toBe('http://')
    expect(normalizeBaseUrl('   ')).toBe('http://')
    expect(normalizeBaseUrl('/')).toBe('http://')
  })
})

describe('allowsPlainHttp', () => {
  it.each([
    'http://127.0.0.1:9119',
    'http://localhost:9119',
    'http://[::1]:9119',
    'http://192.168.1.10:9119',
    'http://10.1.2.3',
    'http://hermes.local',
    'http://hermes',
    'http://100.101.102.103:9119',
    'http://[fd7a:115c:a1e0::1]:9119',
    '192.168.1.10:9119'
  ])('allows %s', address => {
    expect(allowsPlainHttp(address)).toBe(true)
  })

  it.each([
    'http://8.8.8.8:9119',
    'http://hermes.example.com',
    'hermes.example.com',
    'http://100.128.0.1',
    'http://hermes.tail1234.ts.net',
    'http://HERMES.TAIL1234.TS.NET:9119',
    'http://user:pw@192.168.1.10',
    'http://012.0.0.1',
    'http://134744072',
    'ftp://hermes',
    'https:/hermes',
    'http://',
    ''
  ])('refuses %j', address => {
    expect(allowsPlainHttp(address)).toBe(false)
  })

  it('judges the host alone, whatever the scheme', () => {
    expect(allowsPlainHttp('https://192.168.1.10')).toBe(true)
    expect(allowsPlainHttp('https://hermes.example.com')).toBe(false)
  })
})

describe('PUBLIC_HTTP_REFUSAL', () => {
  it('says why the app does not connect to a public address over plain http', () => {
    expect(PUBLIC_HTTP_REFUSAL).toBe('This address may be on the public internet without encryption. Ergates connects to a public server only over https.')
  })
})
