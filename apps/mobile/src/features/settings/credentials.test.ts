import { describe, expect, it } from 'vitest'

import type { ConnectionGrade } from './connection-grade'
import { BLANK_CREDENTIALS, canCheck, canConnect, credentialsFrom, credentialsReady, firstProvider, signInModeFrom } from './credentials'

describe('the sign-in fields', () => {
  it('start empty, with the basic provider until the gateway names its own', () => {
    expect(BLANK_CREDENTIALS).toEqual({ token: '', provider: 'basic', username: '', password: '' })
  })

  it('are ready in token mode once a token is typed', () => {
    expect(credentialsReady('token', { ...BLANK_CREDENTIALS, token: '  ' })).toBe(false)
    expect(credentialsReady('token', { ...BLANK_CREDENTIALS, token: 'abc' })).toBe(true)
  })

  it('are ready in password mode once a username and a password are typed', () => {
    expect(credentialsReady('password', { ...BLANK_CREDENTIALS, username: 'jop' })).toBe(false)
    expect(credentialsReady('password', { ...BLANK_CREDENTIALS, username: ' ', password: 'pw' })).toBe(false)
    expect(credentialsReady('password', { ...BLANK_CREDENTIALS, username: 'jop', password: 'pw' })).toBe(true)
  })

  it('send only the fields of their mode', () => {
    const typed = { token: 'abc', provider: 'github', username: 'jop', password: 'pw' }

    expect(credentialsFrom('token', typed)).toEqual({ mode: 'token', token: 'abc' })
    expect(credentialsFrom('password', typed)).toEqual({ mode: 'password', provider: 'github', username: 'jop', password: 'pw' })
  })
})

describe('canConnect', () => {
  const ready = { ...BLANK_CREDENTIALS, username: 'jop', password: 'pw' }
  const PRIVATE: ConnectionGrade = { kind: 'private', via: 'lan' }
  const PUBLIC: ConnectionGrade = { kind: 'public' }

  it('is true for a private or a public grade with the fields filled in', () => {
    expect(canConnect(PRIVATE, 'password', ready)).toBe(true)
    expect(canConnect(PUBLIC, 'password', ready)).toBe(true)
    expect(canConnect(PRIVATE, 'token', { ...BLANK_CREDENTIALS, token: 'abc' })).toBe(true)
  })

  it.each<ConnectionGrade>([
    { kind: 'unsafe', reason: 'public_http' },
    { kind: 'unsafe', reason: 'public_token' }
  ])('is false for an unsafe grade, however well the fields are filled in: %o', grade => {
    expect(canConnect(grade, 'password', ready)).toBe(false)
    expect(canConnect(grade, 'token', { ...BLANK_CREDENTIALS, token: 'abc' })).toBe(false)
  })

  it('is false while the fields are not ready', () => {
    expect(canConnect(PRIVATE, 'password', { ...ready, password: '' })).toBe(false)
    expect(canConnect(PUBLIC, 'token', BLANK_CREDENTIALS)).toBe(false)
  })

  it('is false before the server has answered, which has no grade yet', () => {
    expect(canConnect(null, 'password', ready)).toBe(false)
  })
})

describe('canCheck', () => {
  it.each(['', '   ', 'http://', 'https://', '  HTTPS://  ', 'https:///', 'http://:9119', 'http://user@', 'ftp://', 'https:/'])(
    'is false while the address has no host: %j',
    address => {
      expect(canCheck(address)).toBe(false)
    }
  )

  // Check grades these, and refuses the ones that are not private or https.
  it.each(['http://127.0.0.1:9119', '192.168.1.10:9119', '[::1]:9119', 'hermes', 'https://hermes.example.com', 'http://8.8.8.8', 'ftp://hermes', 'https:/hermes'])(
    'is true once a host is typed: %j',
    address => {
      expect(canCheck(address)).toBe(true)
    }
  )
})

describe('firstProvider', () => {
  it('is the provider the gateway lists first, or none', () => {
    expect(firstProvider({ auth_providers: ['github', 'basic'] })).toBe('github')
    expect(firstProvider({ auth_providers: [] })).toBeUndefined()
  })
})

describe('signInModeFrom', () => {
  it('follows how the server signs in now, whatever mode was saved', () => {
    expect(signInModeFrom({ auth_required: true }, 'token')).toBe('password')
    expect(signInModeFrom({ auth_required: false }, 'password')).toBe('token')
    expect(signInModeFrom({ auth_required: true }, 'password')).toBe('password')
  })

  it('keeps the saved mode until the server has answered, or when it cannot be asked', () => {
    expect(signInModeFrom(null, 'token')).toBe('token')
    expect(signInModeFrom(null, 'password')).toBe('password')
  })
})
