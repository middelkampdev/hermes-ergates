import { describe, expect, it } from 'vitest'

import { GatewayError, mapHttpError } from '@/gateway/errors'

import { homeErrorLine } from './home-error'

describe('homeErrorLine', () => {
  it('offers to sign in again when the server no longer accepts the sign-in', () => {
    expect(homeErrorLine(mapHttpError(401, { detail: 'Unauthorized' }))).toEqual({ text: 'Sign-in required. Tap to sign in again.', signIn: true })
  })

  it('asks for a pull to retry when the roster failed for any other reason', () => {
    const retry = { text: 'Could not load your assistants. Pull to retry.', signIn: false }

    expect(homeErrorLine(new GatewayError('network', 'No connection to the gateway.'))).toEqual(retry)
    expect(homeErrorLine(mapHttpError(403, { detail: 'Forbidden' }))).toEqual(retry)
    expect(homeErrorLine(mapHttpError(500))).toEqual(retry)
  })

  it('asks for a pull to retry when the error did not come from the gateway', () => {
    const retry = { text: 'Could not load your assistants. Pull to retry.', signIn: false }

    expect(homeErrorLine(new Error('Sign-in required.'))).toEqual(retry)
    expect(homeErrorLine({ kind: 'unauthorized' })).toEqual(retry)
  })
})
