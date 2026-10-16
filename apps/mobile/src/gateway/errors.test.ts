import { describe, expect, it } from 'vitest'

import { jsonRpcErrorFromFrame } from '@vendor/hermes/shared/json-rpc-channel'

import { PUBLIC_HTTP_REFUSAL } from './address'
import { GatewayError, InsecureTransportError, isGatewayError, mapErgatesError, mapHttpError, mapRpcError, mapSocketClose, redact, requireSecureTransport, userMessage } from './errors'

describe('mapHttpError', () => {
  it('maps 401 to unauthorized', () => {
    expect(mapHttpError(401).kind).toBe('unauthorized')
  })
  it('maps 429 to rate_limited with a plain message', () => {
    const err = mapHttpError(429, { detail: 'Too many login attempts. Try again shortly.' })
    expect(err.kind).toBe('rate_limited')
    expect(err.status).toBe(429)
  })
  it('uses the body detail for other statuses', () => {
    expect(mapHttpError(404, { detail: 'Unknown provider' }).message).toBe('Unknown provider')
  })
})

describe('mapErgatesError', () => {
  it('keeps the error code and the safe message of an Ergates error body', () => {
    const err = mapErgatesError(409, { error: { code: 'out_of_order', message: "'configured' cannot be reported before 'plugin_enabled' is done" } })
    expect(err).toMatchObject({ kind: 'unknown', status: 409, code: 'out_of_order', message: "'configured' cannot be reported before 'plugin_enabled' is done" })
    expect(mapErgatesError(404, { error: { code: 'not_found', message: 'no proposal' } })).toMatchObject({ kind: 'not_found', code: 'not_found' })
  })
  it('maps an answer without an Ergates error body like any HTTP error', () => {
    const err = mapErgatesError(401, { detail: 'Unauthorized' })
    expect(err).toMatchObject({ kind: 'unauthorized', status: 401 })
    expect(err.code).toBeUndefined()
  })
  it('redacts secrets in a server message', () => {
    expect(mapErgatesError(400, { error: { code: 'invalid', message: 'bad token=abc' } }).message).toBe('bad token=<redacted>')
  })
})

describe('mapRpcError', () => {
  it('maps busy codes', () => {
    const err = Object.assign(new Error('session busy'), { name: 'JsonRpcGatewayError', code: 4090 })
    expect(mapRpcError(err).kind).toBe('busy')
  })
  it('maps session-not-found codes', () => {
    const err = Object.assign(new Error('session not found'), { name: 'JsonRpcGatewayError', code: 4007 })
    expect(mapRpcError(err).kind).toBe('not_found')
  })
  it('maps the 4001 a session-scoped RPC answers for a runtime id Hermes no longer holds', () => {
    // A `hermes serve` restart forgets every live id: `_sess_nowait` answers this frame (tui_gateway/server.py:1229-1245).
    expect(mapRpcError(jsonRpcErrorFromFrame({ code: 4001, message: 'session not found' }))).toMatchObject({ kind: 'not_found', code: 4001 })
  })
  it('keeps every other 4001 a plain rpc error', () => {
    for (const message of ['slug and api_key are required', 'no active session', 'session not found or not owned by this transport']) {
      expect(mapRpcError(jsonRpcErrorFromFrame({ code: 4001, message })).kind).toBe('rpc')
    }
  })
  it('maps vendored client timeouts', () => {
    expect(mapRpcError(new Error('request timed out after 120s: prompt.submit')).kind).toBe('timeout')
  })
  it('maps closed sockets to network', () => {
    expect(mapRpcError(new Error('WebSocket closed')).kind).toBe('network')
    expect(mapRpcError(new Error('gateway not connected')).kind).toBe('network')
  })
  it('passes GatewayError through unchanged', () => {
    const original = new GatewayError('forbidden', 'x')
    expect(mapRpcError(original)).toBe(original)
  })
})

describe('mapSocketClose', () => {
  it('maps 4401 and 4403', () => {
    expect(mapSocketClose(4401).kind).toBe('unauthorized')
    expect(mapSocketClose(4403, 'host_mismatch').kind).toBe('forbidden')
    expect(mapSocketClose(1006).kind).toBe('network')
  })
})

describe('redaction', () => {
  it('strips query-style secrets', () => {
    expect(redact('ws://h/api/ws?profile=a&token=abc123&x=1')).toBe('ws://h/api/ws?profile=a&token=<redacted>&x=1')
    expect(redact('ticket=zzz expired')).toBe('ticket=<redacted> expired')
  })
  it('never leaks a token through userMessage', () => {
    const text = userMessage(new Error('bad url ws://h/api/ws?token=secret-value'))
    expect(text).not.toContain('secret-value')
  })
})

describe('requireSecureTransport', () => {
  it.each(['http://127.0.0.1:9119', 'http://192.168.1.10:9119', 'http://100.101.102.103:9119', 'http://hermes.local', 'https://hermes.example.com', 'https://hermes.tail1234.ts.net'])(
    'lets %s through',
    baseUrl => {
      expect(() => requireSecureTransport(baseUrl)).not.toThrow()
    }
  )

  it.each(['http://8.8.8.8:9119', 'http://hermes.example.com', 'http://hermes.tail1234.ts.net', 'hermes.example.com', 'http://'])('refuses %s with the public http copy', baseUrl => {
    expect(() => requireSecureTransport(baseUrl)).toThrow(InsecureTransportError)
    expect(() => requireSecureTransport(baseUrl)).toThrow(PUBLIC_HTTP_REFUSAL)
  })
})

describe('InsecureTransportError', () => {
  it('is an Error that carries the public http copy and says so in userMessage', () => {
    const error = new InsecureTransportError()
    expect(error).toBeInstanceOf(Error)
    expect(error.message).toBe(PUBLIC_HTTP_REFUSAL)
    expect(userMessage(error)).toBe(PUBLIC_HTTP_REFUSAL)
  })

  // Every screen that maps gateway errors by kind (Home, Settings, the chat) then shows the refusal, not a generic failure.
  it('is a gateway error of the insecure_transport kind', () => {
    const error = new InsecureTransportError()
    expect(isGatewayError(error)).toBe(true)
    expect(error.kind).toBe('insecure_transport')
    expect(mapRpcError(error)).toBe(error)
  })

  it('maps the insecure_transport kind to the public http copy in userMessage, whatever the message', () => {
    expect(userMessage(new GatewayError('insecure_transport', 'x'))).toBe(PUBLIC_HTTP_REFUSAL)
  })
})
