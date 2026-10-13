import { describe, expect, it } from 'vitest'

import { GatewayError, mapHttpError } from '@/gateway/errors'

import { homeErrorLine } from './home-error'

const SIGN_IN = { text: 'Sign-in required. Tap to sign in again.', signIn: true }
const RETRY = { text: 'Could not load your assistants. Pull to retry.', signIn: false }
const SIGNED_OUT = mapHttpError(401, { detail: 'Unauthorized' })

describe('homeErrorLine', () => {
  it('offers to sign in again when the server no longer accepts the sign-in', () => {
    expect(homeErrorLine(SIGNED_OUT, null)).toEqual(SIGN_IN)
  })

  it('offers to sign in again when the server check was refused, whatever the roster failed with', () => {
    // After a restart with a new token the roster fails over the socket, which carries no 401; the check's HTTP read does.
    expect(homeErrorLine(new GatewayError('network', 'No connection to the gateway.'), SIGNED_OUT)).toEqual(SIGN_IN)
    expect(homeErrorLine(mapHttpError(500), SIGNED_OUT)).toEqual(SIGN_IN)
  })

  it('offers to sign in again when only the server check was refused', () => {
    expect(homeErrorLine(null, SIGNED_OUT)).toEqual(SIGN_IN)
    expect(homeErrorLine(undefined, SIGNED_OUT)).toEqual(SIGN_IN)
  })

  it('asks for a pull to retry when the roster failed for any other reason', () => {
    expect(homeErrorLine(new GatewayError('network', 'No connection to the gateway.'), null)).toEqual(RETRY)
    expect(homeErrorLine(mapHttpError(403, { detail: 'Forbidden' }), null)).toEqual(RETRY)
    expect(homeErrorLine(mapHttpError(500), new GatewayError('network', 'No connection to the gateway.'))).toEqual(RETRY)
  })

  it('asks for a pull to retry when the error did not come from the gateway', () => {
    expect(homeErrorLine(new Error('Sign-in required.'), null)).toEqual(RETRY)
    expect(homeErrorLine({ kind: 'unauthorized' }, { kind: 'unauthorized' })).toEqual(RETRY)
  })

  it('shows no line when the roster loaded and the check was not refused', () => {
    expect(homeErrorLine(null, null)).toBeNull()
    expect(homeErrorLine(undefined, new GatewayError('network', 'No connection to the gateway.'))).toBeNull()
  })
})
