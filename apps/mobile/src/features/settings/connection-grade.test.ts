import { describe, expect, it } from 'vitest'

import {
  addressGrade,
  connectionGrade,
  GRADE_GUIDE,
  gradeLabel,
  gradeLine,
  guideLabel,
  MIN_PUBLIC_PASSWORD,
  PASSWORD_TOO_SHORT,
  passwordProblem,
  type ConnectionGrade
} from './connection-grade'

const LOOPBACK: ConnectionGrade = { kind: 'private', via: 'loopback' }
const TAILSCALE: ConnectionGrade = { kind: 'private', via: 'tailscale' }
const LAN: ConnectionGrade = { kind: 'private', via: 'lan' }
const PUBLIC: ConnectionGrade = { kind: 'public' }
const PUBLIC_HTTP: ConnectionGrade = { kind: 'unsafe', reason: 'public_http' }
const PUBLIC_TOKEN: ConnectionGrade = { kind: 'unsafe', reason: 'public_token' }

const TAILSCALE_NAME = 'hermes.tail1234.ts.net'

/** The grade for an address and whether the server asks for a password, as the screens work it out. */
function gradeOf(baseUrl: string, authRequired: boolean): ConnectionGrade {
  return connectionGrade(baseUrl, { auth_required: authRequired })
}

describe('addressGrade', () => {
  it.each([
    ['http://127.0.0.1:9119', LOOPBACK],
    ['http://localhost:9119', LOOPBACK],
    ['http://[::1]:9119', LOOPBACK],
    ['http://192.168.1.10:9119', LAN],
    ['http://hermes.local', LAN],
    ['http://hermes', LAN],
    ['http://100.64.0.1:9119', TAILSCALE],
    ['http://[fd7a:115c:a1e0::1]:9119', TAILSCALE]
  ])('grades %s without asking the server', (address, grade) => {
    expect(addressGrade(address)).toEqual(grade)
  })

  it.each(['http://167.233.238.119', 'http://hermes.example.com', 'http://hermes.example.com:9119', 'hermes.example.com', 'http://100.128.0.1'])(
    'refuses a public address over http: %s',
    address => {
      expect(addressGrade(address)).toEqual(PUBLIC_HTTP)
    }
  )

  it.each(['https://167.233.238.119', 'https://hermes.example.com', 'https://hermes.example.com:9119', 'https://ts.net'])(
    'needs the server to answer for a public address over https: %s',
    address => {
      expect(addressGrade(address)).toBeNull()
    }
  )

  it.each([`https://${TAILSCALE_NAME}`, `https://${TAILSCALE_NAME}.`, `https://${TAILSCALE_NAME.toUpperCase()}`])(
    'needs the server to answer for a Tailscale name over https, since Funnel can publish it: %s',
    address => {
      expect(addressGrade(address)).toBeNull()
    }
  )

  it.each([`http://${TAILSCALE_NAME}`, `http://${TAILSCALE_NAME}:9119`, `http://${TAILSCALE_NAME}.`, `http://${TAILSCALE_NAME.toUpperCase()}`])(
    'refuses a Tailscale name over http, since without Tailscale a spoofer on the local network could answer for it: %s',
    address => {
      expect(addressGrade(address)).toEqual(PUBLIC_HTTP)
    }
  )

  it.each([
    ['https://127.0.0.1', LOOPBACK],
    ['https://192.168.1.10', LAN],
    ['https://100.64.0.1', TAILSCALE]
  ])('grades a private address the same over https: %s', (address, grade) => {
    expect(addressGrade(address)).toEqual(grade)
  })

  it.each(['http://012.0.0.1', 'http://user:pw@192.168.1.10', 'http://1.1.1.1@192.168.1.10', 'http://hermes.café'])(
    'does not trust a host the phone may read differently: %s',
    address => {
      expect(addressGrade(address)).toEqual(PUBLIC_HTTP)
    }
  )

  it('does not trust a Tailscale name behind a user name, so it never asks an http address', () => {
    expect(addressGrade(`http://user@${TAILSCALE_NAME}`)).toEqual(PUBLIC_HTTP)
    expect(addressGrade(`https://user@${TAILSCALE_NAME}`)).toBeNull()
  })

  it('refuses an empty address, which reads as public over http', () => {
    expect(addressGrade('')).toEqual(PUBLIC_HTTP)
  })

  it('needs the server to answer for a bare https://, which keeps its scheme and has no readable host', () => {
    expect(addressGrade('https://')).toBeNull()
    expect(addressGrade('http://')).toEqual(PUBLIC_HTTP)
  })

  it.each([`http://x.ts.net\\@evil.com`, `http://${TAILSCALE_NAME}\\@evil.com`])('refuses a backslash after an http host: %s', address => {
    expect(addressGrade(address)).toEqual(PUBLIC_HTTP)
  })
})

describe('connectionGrade', () => {
  it.each([
    ['http://127.0.0.1:9119', LOOPBACK],
    ['http://192.168.1.10:9119', LAN],
    ['http://100.101.102.103:9119', TAILSCALE],
    ['http://[fd7a:115c:a1e0::1]:9119', TAILSCALE],
    ['https://127.0.0.1', LOOPBACK],
    ['https://192.168.1.10', LAN],
    ['https://100.101.102.103', TAILSCALE]
  ])('keeps %s private whether or not the server asks for a password', (address, grade) => {
    expect(gradeOf(address, true)).toEqual(grade)
    expect(gradeOf(address, false)).toEqual(grade)
  })

  it('grades a Tailscale name over https like any public name, since Funnel can publish it', () => {
    expect(gradeOf(`https://${TAILSCALE_NAME}`, true)).toEqual(PUBLIC)
    expect(gradeOf(`https://${TAILSCALE_NAME}`, false)).toEqual(PUBLIC_TOKEN)
  })

  it('refuses a Tailscale name over http whatever the server says', () => {
    expect(gradeOf('http://hermes.tailnet.ts.net', true)).toEqual(PUBLIC_HTTP)
    expect(gradeOf('http://hermes.tailnet.ts.net', false)).toEqual(PUBLIC_HTTP)
  })

  it('grades a public address over https public when it asks for a password', () => {
    expect(gradeOf('https://hermes.example.com', true)).toEqual(PUBLIC)
    expect(gradeOf('https://167.233.238.119:9119', true)).toEqual(PUBLIC)
  })

  it('refuses a public address over https that signs in without a password', () => {
    expect(gradeOf('https://hermes.example.com', false)).toEqual(PUBLIC_TOKEN)
    expect(gradeOf('https://167.233.238.119:9119', false)).toEqual(PUBLIC_TOKEN)
  })

  it('refuses a public address over http whatever the server says', () => {
    expect(gradeOf('http://hermes.example.com', true)).toEqual(PUBLIC_HTTP)
    expect(gradeOf('http://hermes.example.com', false)).toEqual(PUBLIC_HTTP)
  })

  it('fails closed when the server does not say whether it asks for a password', () => {
    expect(connectionGrade('https://hermes.example.com', {} as never)).toEqual(PUBLIC_TOKEN)
    expect(connectionGrade(`https://${TAILSCALE_NAME}`, {} as never)).toEqual(PUBLIC_TOKEN)
  })

  it.each([`https://x.ts.net\\@evil.com`, `https://${TAILSCALE_NAME}\\@evil.com`])('never grades a backslash after the host private: %s', address => {
    expect(gradeOf(address, true)).toEqual(PUBLIC)
    expect(gradeOf(address, false)).toEqual(PUBLIC_TOKEN)
  })

  it('grades a Tailscale name behind a user name as public, and refuses it over http', () => {
    expect(gradeOf(`https://user@${TAILSCALE_NAME}`, true)).toEqual(PUBLIC)
    expect(gradeOf(`https://user@${TAILSCALE_NAME}`, false)).toEqual(PUBLIC_TOKEN)
    expect(gradeOf(`http://user@${TAILSCALE_NAME}`, true)).toEqual(PUBLIC_HTTP)
  })
})

describe('passwordProblem', () => {
  it('asks a public server for at least 12 characters', () => {
    expect(MIN_PUBLIC_PASSWORD).toBe(12)
    expect(passwordProblem(PUBLIC, '')).toBe('too_short')
    expect(passwordProblem(PUBLIC, 'a'.repeat(11))).toBe('too_short')
    expect(passwordProblem(PUBLIC, 'a'.repeat(12))).toBeNull()
    expect(passwordProblem(PUBLIC, 'a'.repeat(40))).toBeNull()
  })

  it('asks a Tailscale name for the same 12 characters, since Funnel can publish it', () => {
    const grade = gradeOf(`https://${TAILSCALE_NAME}`, true)

    expect(passwordProblem(grade, 'a'.repeat(11))).toBe('too_short')
    expect(passwordProblem(grade, 'a'.repeat(12))).toBeNull()
  })

  it('counts each emoji as one character', () => {
    expect(passwordProblem(PUBLIC, '😀'.repeat(11))).toBe('too_short')
    expect(passwordProblem(PUBLIC, '😀'.repeat(12))).toBeNull()
  })

  it('counts spaces, since the app sends the password as typed', () => {
    expect(passwordProblem(PUBLIC, ' '.repeat(12))).toBeNull()
    expect(passwordProblem(PUBLIC, '  abcdefghi  ')).toBeNull()
  })

  it.each([LOOPBACK, TAILSCALE, LAN])('asks a private server for no length: %o', grade => {
    expect(passwordProblem(grade, 'a')).toBeNull()
    expect(passwordProblem(grade, '')).toBeNull()
  })

  it.each([PUBLIC_HTTP, PUBLIC_TOKEN])('has no length to ask of an unsafe grade: %o', grade => {
    expect(passwordProblem(grade, 'a')).toBeNull()
  })

  it('words the problem for the sign-in screen', () => {
    expect(PASSWORD_TOO_SHORT).toBe('On a public server, use a password of at least 12 characters.')
  })
})

describe('gradeLine', () => {
  it('names the version and where a private server runs', () => {
    expect(gradeLine(LOOPBACK, '0.21.6')).toBe('Hermes 0.21.6. Private: this server runs on this device.')
    expect(gradeLine(TAILSCALE, '0.21.6')).toBe('Hermes 0.21.6. Private: Tailscale encrypts this connection.')
    expect(gradeLine(LAN, '0.21.6')).toBe('Hermes 0.21.6. Private: a server on your local network.')
  })

  it('names the version and warns that a public server is reachable by anyone', () => {
    expect(gradeLine(PUBLIC, '0.21.6')).toBe(
      'Hermes 0.21.6. Ergates treats this address as public, so anyone on the internet may reach it. Use a password of at least 12 characters, or connect over Tailscale.'
    )
  })

  it('says why an unsafe address is refused, without a version', () => {
    expect(gradeLine(PUBLIC_HTTP, '0.21.6')).toBe(
      'This address may be on the public internet without encryption. Ergates connects to a public server only over https.'
    )
    expect(gradeLine(PUBLIC_TOKEN, '0.21.6')).toBe(
      'This public server signs in without a password. Ergates connects to a public server only with a password.'
    )
  })

  it('puts the version in as typed, even when it holds a replacement pattern', () => {
    expect(gradeLine(LOOPBACK, '$&')).toBe('Hermes $&. Private: this server runs on this device.')
  })
})

describe('gradeLabel', () => {
  it('labels each grade the way Settings and Connect show it', () => {
    expect(gradeLabel(LOOPBACK)).toBe('Private (this device)')
    expect(gradeLabel(TAILSCALE)).toBe('Private (Tailscale)')
    expect(gradeLabel(LAN)).toBe('Private (local network)')
    expect(gradeLabel(PUBLIC)).toBe('Public, encrypted')
  })

  it.each([PUBLIC_HTTP, PUBLIC_TOKEN])('labels an unsafe grade Unsafe: %o', grade => {
    expect(gradeLabel(grade)).toBe('Unsafe')
  })
})

describe('GRADE_GUIDE', () => {
  it('points a public grade at public access, and a private or unsafe one at how to stay private', () => {
    expect(GRADE_GUIDE).toEqual({
      private: 'https://middelkamp.dev/ergates/server/#private-access',
      public: 'https://middelkamp.dev/ergates/server/#public-access',
      unsafe: 'https://middelkamp.dev/ergates/server/#private-access'
    })
  })
})

describe('guideLabel', () => {
  it('offers how to stay private for an unsafe grade, and the server guide for any other', () => {
    expect(guideLabel(PUBLIC_HTTP)).toBe('How to stay private')
    expect(guideLabel(PUBLIC_TOKEN)).toBe('How to stay private')
    expect(guideLabel(PUBLIC)).toBe('Server guide')
    expect(guideLabel(LOOPBACK)).toBe('Server guide')
    expect(guideLabel(TAILSCALE)).toBe('Server guide')
    expect(guideLabel(LAN)).toBe('Server guide')
  })
})
