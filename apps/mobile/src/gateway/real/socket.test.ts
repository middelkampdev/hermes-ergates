import { afterEach, describe, expect, it, vi } from 'vitest'

import { FakeWebSocket, fakeSocketFactory, flush, installFakeWebSocket } from '@test/fake-gateway/fake-websocket'

import { PUBLIC_HTTP_REFUSAL } from '../address'
import { GatewayError, InsecureTransportError, isGatewayError } from '../errors'
import type { ServerRequestFrame } from '../types'
import { buildSocketUrl } from './auth'
import { SocketSession } from './socket'

const originalWebSocket = (globalThis as { WebSocket?: unknown }).WebSocket

const OPTS = { baseUrl: 'http://127.0.0.1:9119', profile: 'default', credential: async () => ({ token: 'tok' }), socketFactory: fakeSocketFactory }

/** The frames the client sent with this JSON-RPC id. */
const framesFor = (ws: FakeWebSocket, id: string) => ws.sent.filter(f => f.id === id)

afterEach(() => {
  ;(globalThis as { WebSocket?: unknown }).WebSocket = originalWebSocket
})

describe('buildSocketUrl', () => {
  it('encodes profile and credential', () => {
    expect(buildSocketUrl('http://127.0.0.1:9119', 'default', { token: 'a b' })).toBe('ws://127.0.0.1:9119/api/ws?profile=default&token=a+b')
    expect(buildSocketUrl('https://gw.tail.net/', 'kevin', { ticket: 't1', token: 'ignored' })).toBe('wss://gw.tail.net/api/ws?profile=kevin&ticket=t1')
  })
})

describe('SocketSession', () => {
  it('opens, waits for gateway.ready and answers requests', async () => {
    installFakeWebSocket({ onRequest: method => (method === 'gateway.capabilities' ? { per_session_exclusive_submit: true } : {}) })
    const session = await SocketSession.open({ baseUrl: 'http://127.0.0.1:9119', profile: 'default', credential: async () => ({ token: 'tok' }), socketFactory: fakeSocketFactory })
    expect(FakeWebSocket.instances[0]?.url).toBe('ws://127.0.0.1:9119/api/ws?profile=default&token=tok')
    expect(session.ready.replay_epoch).toBe('epoch-fake')
    expect(session.state).toBe('open')
    await expect(session.request('gateway.capabilities')).resolves.toEqual({ per_session_exclusive_submit: true })
    session.close()
    expect(session.state).toBe('closed')
  })

  it('delivers events and maps rpc errors', async () => {
    installFakeWebSocket({
      onRequest: method => {
        if (method === 'prompt.submit') {
          throw Object.assign(new Error('busy'), { code: 4090 })
        }
        return {}
      }
    })
    const session = await SocketSession.open({ baseUrl: 'http://127.0.0.1:9119', profile: 'default', credential: async () => ({ token: 'tok' }), socketFactory: fakeSocketFactory })
    const seen: string[] = []
    session.onEvent(e => seen.push(e.type))
    FakeWebSocket.instances[0]?.serverEvent({ type: 'message.start', session_id: 's1', seq: 1 })
    await flush()
    expect(seen).toContain('message.start')
    await expect(session.request('prompt.submit', { session_id: 's1', text: 'x' })).rejects.toSatisfy((e: unknown) => isGatewayError(e) && e.kind === 'busy')
    session.close()
  })

  it('surfaces a 4401 close as unauthorized and does not reconnect', async () => {
    installFakeWebSocket({ closeOnOpen: { code: 4401, reason: 'auth: token_mismatch' } })
    await expect(SocketSession.open({ baseUrl: 'http://127.0.0.1:9119', profile: 'default', credential: async () => ({ token: 'bad' }), socketFactory: fakeSocketFactory, readyTimeoutMs: 200 })).rejects.toSatisfy((e: unknown) => isGatewayError(e) && e.kind === 'unauthorized')
    await flush(20)
    expect(FakeWebSocket.instances).toHaveLength(1)
  })

  it('reconnects with a fresh credential after a drop', async () => {
    installFakeWebSocket({})
    let mint = 0
    const session = await SocketSession.open({ baseUrl: 'http://127.0.0.1:9119', profile: 'default', credential: async () => ({ ticket: `t${++mint}` }), socketFactory: fakeSocketFactory, backoffMs: [5] })
    const states: string[] = []
    session.onState(s => states.push(s))
    FakeWebSocket.instances[0]?.serverClose(1006)
    // Wait for the reconnect itself: a fixed pause was too short on a busy machine.
    await vi.waitFor(() => expect(states).toEqual(['open', 'closed', 'connecting', 'open']))
    expect(FakeWebSocket.instances).toHaveLength(2)
    expect(FakeWebSocket.instances[1]?.url).toContain('ticket=t2')
    expect(session.terminal).toBe(false)
    session.close()
  })

  it('keeps reconnecting after a plain drop instead of blaming a stale auth close', async () => {
    // A close error recorded during one dial must not be reported as the cause of
    // a later network drop, nor disarm the reconnect for the object's lifetime.
    installFakeWebSocket({})
    const session = await SocketSession.open({ baseUrl: 'http://127.0.0.1:9119', profile: 'default', credential: async () => ({ token: 'tok' }), socketFactory: fakeSocketFactory, backoffMs: [5] })
    FakeWebSocket.instances[0]?.serverClose(1006)
    // Wait for each reconnect itself: a fixed pause was too short on a busy machine.
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2))
    await vi.waitFor(() => expect(session.state).toBe('open'))
    FakeWebSocket.instances[1]?.serverClose(1006)
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(3))
    await vi.waitFor(() => expect(session.state).toBe('open'))
    expect(session.lastError).toBeNull()
    session.close()
  })

  it('goes terminal on a 4401 after a healthy open, reports it, and stops reconnecting', async () => {
    installFakeWebSocket({})
    const terminal: string[] = []
    const session = await SocketSession.open({
      baseUrl: 'http://127.0.0.1:9119',
      profile: 'default',
      credential: async () => ({ ticket: 't1' }),
      socketFactory: fakeSocketFactory,
      backoffMs: [5],
      onTerminal: err => terminal.push(err.kind)
    })
    FakeWebSocket.instances[0]?.serverClose(4401, 'auth: ticket expired')
    await flush(40)
    expect(FakeWebSocket.instances).toHaveLength(1)
    expect(session.terminal).toBe(true)
    expect(session.state).toBe('error')
    expect(session.lastError).toMatchObject({ kind: 'unauthorized', terminal: true, code: 4401 })
    // The owner is told so it can drop this socket and let a re-login rebuild it.
    expect(terminal).toEqual(['unauthorized'])
    // A foreground nudge must not retry a dead credential either.
    await session.reconnectNow()
    expect(FakeWebSocket.instances).toHaveLength(1)
    session.close()
  })

  it('reports a reconnect as open only after gateway.ready, so an activate follows client.capabilities', async () => {
    installFakeWebSocket({})
    const session = await SocketSession.open({ ...OPTS, backoffMs: [5] })
    const states: string[] = []
    // What the chat controller does: rebind the session as soon as the socket reports open again.
    session.onState(state => {
      states.push(state)
      if (state === 'open' && states.length > 1) {
        void session.request('session.activate', { session_id: 's1', omit_messages: true }).catch(() => undefined)
      }
    })
    FakeWebSocket.instances[0]!.serverClose(1006)
    await vi.waitFor(() => expect(FakeWebSocket.instances[1]?.sent.some(f => f.method === 'session.activate')).toBe(true))

    // Hermes reads no frame before it sent gateway.ready and then reads them in order
    // (tui_gateway/ws.py:365-397): an activate ahead of client.capabilities rebinds the
    // session to a socket that has not said it answers requests, and an approval raised
    // then is withdrawn (session_transports.py:38-48, server.py:833-846).
    const methods = FakeWebSocket.instances[1]!.sent.map(f => f.method)
    expect(methods.indexOf('client.capabilities')).toBeGreaterThanOrEqual(0)
    expect(methods.indexOf('client.capabilities')).toBeLessThan(methods.indexOf('session.activate'))
    session.close()
  })

  it('drops a socket that never announces readiness, and the reconnect dials a fresh one', async () => {
    installFakeWebSocket({ withholdReady: ws => FakeWebSocket.instances.indexOf(ws) === 1 })
    const session = await SocketSession.open({ ...OPTS, backoffMs: [5], readyTimeoutMs: 30 })
    FakeWebSocket.instances[0]!.serverClose(1006)
    // Hermes sends gateway.ready once per connection: waiting on the same socket again cannot succeed.
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(3))
    expect(FakeWebSocket.instances[1]!.readyState).toBe(FakeWebSocket.CLOSED)
    await vi.waitFor(() => expect(session.state).toBe('open'))
    session.close()
  })

  it('stops dialing when the first open fails', async () => {
    installFakeWebSocket({ closeOnOpen: { code: 1006 } })
    await expect(SocketSession.open({ ...OPTS, backoffMs: [5] })).rejects.toSatisfy((e: unknown) => isGatewayError(e) && e.kind === 'network')
    // Nobody holds the session: RealGateway drops it and builds a new one on the next connect.
    await flush(40)
    expect(FakeWebSocket.instances).toHaveLength(1)
  })

  it('treats a failed ticket mint as terminal, before any socket exists', async () => {
    installFakeWebSocket({})
    const terminal: string[] = []
    await expect(
      SocketSession.open({
        baseUrl: 'http://127.0.0.1:9119',
        profile: 'default',
        credential: async () => {
          throw new GatewayError('unauthorized', 'Sign-in required.')
        },
        socketFactory: fakeSocketFactory,
        backoffMs: [5],
        onTerminal: err => terminal.push(err.kind)
      })
    ).rejects.toSatisfy((e: unknown) => isGatewayError(e) && e.kind === 'unauthorized')
    // Without this the app re-mints against a dead cookie every 10s forever.
    expect(terminal).toEqual(['unauthorized'])
    expect(FakeWebSocket.instances).toHaveLength(0)
  })
})

describe('SocketSession transport guard', () => {
  it.each(['http://8.8.8.8:9119', 'http://hermes.example.com', 'http://hermes.tail1234.ts.net', 'http://HERMES.TAIL1234.TS.NET:9119'])(
    'refuses %s over plain http before it asks for a credential or opens a socket',
    async baseUrl => {
      installFakeWebSocket({})
      const credential = vi.fn(async () => ({ token: 'tok' }))
      const socketFactory = vi.fn(fakeSocketFactory)

      const opening = SocketSession.open({ baseUrl, profile: 'default', credential, socketFactory, backoffMs: [5] })

      await expect(opening).rejects.toBeInstanceOf(InsecureTransportError)
      await expect(opening).rejects.toThrow(PUBLIC_HTTP_REFUSAL)
      // A gateway error like any other socket failure, so the screens map it by its kind.
      await expect(opening).rejects.toSatisfy((e: unknown) => isGatewayError(e) && e.kind === 'insecure_transport')
      await flush(40)
      expect(credential).not.toHaveBeenCalled()
      expect(socketFactory).not.toHaveBeenCalled()
      expect(FakeWebSocket.instances).toHaveLength(0)
    }
  )

  it.each(['http://192.168.1.10:9119', 'http://100.101.102.103:9119', 'http://127.0.0.1:9119'])('opens %s over plain http', async baseUrl => {
    installFakeWebSocket({})

    const session = await SocketSession.open({ ...OPTS, baseUrl })

    expect(session.state).toBe('open')
    expect(FakeWebSocket.instances[0]?.url).toBe(`ws://${baseUrl.slice('http://'.length)}/api/ws?profile=default&token=tok`)
    session.close()
  })

  it('opens a public address over https', async () => {
    installFakeWebSocket({})

    const session = await SocketSession.open({ ...OPTS, baseUrl: 'https://hermes.example.com' })

    expect(FakeWebSocket.instances[0]?.url).toBe('wss://hermes.example.com/api/ws?profile=default&token=tok')
    session.close()
  })
})

describe('SocketSession server requests', () => {
  it('tells Hermes once per socket, after gateway.ready, that it answers server requests', async () => {
    installFakeWebSocket({})
    const session = await SocketSession.open({ ...OPTS, backoffMs: [5] })
    const caps = (ws?: FakeWebSocket) => ws?.sent.filter(f => f.method === 'client.capabilities') ?? []
    expect(caps(FakeWebSocket.instances[0])).toMatchObject([{ params: { server_requests: true } }])
    FakeWebSocket.instances[0]!.serverClose(1006)
    await vi.waitFor(() => expect(caps(FakeWebSocket.instances[1])).toHaveLength(1))
    session.close()
  })

  it('accepts an approval request before anyone listens and answers it with one response frame', async () => {
    installFakeWebSocket({})
    const session = await SocketSession.open(OPTS)
    const ws = FakeWebSocket.instances[0]!
    ws.serverRequest('srq-0123456789ab', 'approval', { session_id: 's1', request_id: 'ap1', command: 'rm -rf build', choices: ['once', 'deny'] })
    await flush()
    expect(framesFor(ws, 'srq-0123456789ab')).toEqual([])
    expect(session.respond('srq-0123456789ab', { choice: 'once' })).toBe('sent')
    expect(session.respond('srq-0123456789ab', { choice: 'deny' })).toBe('unknown')
    expect(framesFor(ws, 'srq-0123456789ab')).toEqual([{ jsonrpc: '2.0', id: 'srq-0123456789ab', result: { choice: 'once' } }])
    session.close()
  })

  it('hands approval and clarify to subscribers, with replayed set for open_requests', async () => {
    installFakeWebSocket({ onRequest: m => (m === 'session.activate' ? { open_requests: [{ id: 'srq-aaaaaaaaaaaa', method: 'approval', params: { session_id: 's1', request_id: 'ap1' } }] } : {}) })
    const session = await SocketSession.open(OPTS)
    const seen: ServerRequestFrame[] = []
    session.onRequest(r => seen.push(r))
    FakeWebSocket.instances[0]!.serverRequest('srq-bbbbbbbbbbbb', 'clarify', { session_id: 's1', questions: [{ qid: 'q0', question: 'Tea?' }] })
    await flush()
    await session.request('session.activate', { session_id: 's1' })
    expect(seen).toMatchObject([{ id: 'srq-bbbbbbbbbbbb', method: 'clarify', replayed: false }, { id: 'srq-aaaaaaaaaaaa', method: 'approval', replayed: true }])
    session.close()
  })

  it('declines window-owned requests and leaves sudo and secret unanswered', async () => {
    installFakeWebSocket({ onRequest: m => (m === 'client.capabilities' ? { server_requests: ['approval'], declines_not_shown: true } : {}) })
    const session = await SocketSession.open(OPTS)
    const ws = FakeWebSocket.instances[0]!
    await flush()
    ws.serverRequest('srq-000000000001', 'preview.read', { session_id: 's1' })
    ws.serverRequest('srq-000000000002', 'sudo', { session_id: 's1', command: 'apt install x' })
    ws.serverRequest('srq-000000000003', 'secret', { session_id: 's1', env_var: 'API_KEY', prompt: 'Key?' })
    await flush()
    expect(framesFor(ws, 'srq-000000000001')).toMatchObject([{ error: { code: 4404 } }])
    expect([...framesFor(ws, 'srq-000000000002'), ...framesFor(ws, 'srq-000000000003')]).toEqual([])
    session.close()
  })

  it('does not answer while the socket is down, and forgets a request Hermes cancelled', async () => {
    installFakeWebSocket({})
    const session = await SocketSession.open({ ...OPTS, backoffMs: [60_000] })
    const ws = FakeWebSocket.instances[0]!
    ws.serverRequest('srq-000000000004', 'approval', { session_id: 's1', request_id: 'ap4' })
    ws.serverRequest('srq-000000000005', 'approval', { session_id: 's1', request_id: 'ap5' })
    ws.serverEvent({ type: 'request.cancel', session_id: 's1', seq: 1, payload: { id: 'srq-000000000005', method: 'approval', reason: 'timeout' } })
    await flush()
    expect(session.respond('srq-000000000005', { choice: 'once' })).toBe('unknown')
    ws.serverClose(1006)
    expect(session.respond('srq-000000000004', { choice: 'once' })).toBe('offline')
    expect(framesFor(ws, 'srq-000000000004')).toEqual([])
    session.close()
  })

  it('drops a stale open_requests delivery of an id it answered on this socket, and takes one after a reconnect', async () => {
    const open = [{ id: 'srq-00000000000e', method: 'approval', params: { session_id: 's1', request_id: 'ap14' } }]
    installFakeWebSocket({ onRequest: m => (m === 'session.activate' ? { open_requests: open } : {}) })
    const session = await SocketSession.open({ ...OPTS, backoffMs: [5] })
    const seen: ServerRequestFrame[] = []
    session.onRequest(r => seen.push(r))
    const first = FakeWebSocket.instances[0]!
    first.serverRequest('srq-00000000000e', 'approval', { session_id: 's1', request_id: 'ap14' })
    await flush()
    expect(session.respond('srq-00000000000e', { choice: 'once' })).toBe('sent')

    // Hermes answered this activate before it read the answer, so the snapshot still lists the id.
    await session.request('session.activate', { session_id: 's1' })
    expect(seen.map(r => r.replayed)).toEqual([false])
    expect(session.respond('srq-00000000000e', { choice: 'deny' })).toBe('unknown')
    expect(framesFor(first, 'srq-00000000000e')).toEqual([{ jsonrpc: '2.0', id: 'srq-00000000000e', result: { choice: 'once' } }])

    // On a new socket the answer may have been lost with the old one: the delivery counts.
    first.serverClose(1006)
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2))
    await vi.waitFor(() => expect(session.state).toBe('open'))
    await session.request('session.activate', { session_id: 's1' })
    expect(seen.map(r => r.replayed)).toEqual([false, true])
    expect(session.respond('srq-00000000000e', { choice: 'once' })).toBe('sent')
    expect(framesFor(FakeWebSocket.instances[1]!, 'srq-00000000000e')).toEqual([{ jsonrpc: '2.0', id: 'srq-00000000000e', result: { choice: 'once' } }])
    session.close()
  })
})
