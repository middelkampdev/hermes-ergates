import { describe, expect, it } from 'vitest'

import { BLANK_CREDENTIALS, credentialsFrom, credentialsReady, firstProvider } from './credentials'

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

describe('firstProvider', () => {
  it('is the provider the gateway lists first, or none', () => {
    expect(firstProvider({ auth_providers: ['github', 'basic'] })).toBe('github')
    expect(firstProvider({ auth_providers: [] })).toBeUndefined()
  })
})
