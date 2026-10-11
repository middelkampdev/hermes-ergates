/**
 * Scenario: the phone answers an approval while a reconnect's calls are still
 * on the wire.
 *
 * Hermes handles the frames of one socket in arrival order, and
 * `session.activate` and `session.events.since` run inline
 * (tui_gateway/server.py:181-196, rpc_dispatch.py:54-58). A snapshot for a call
 * sent before the answer still lists the request, and arrives after the answer.
 * Hermes sends no `request.cancel` for an answered request
 * (server_requests.py:262-293), so the card must not reopen on that socket.
 *
 * This runs the real adapter over the WebSocket double: the fake connection
 * removes an answered request from the same map that stands in for Hermes's
 * open requests, so it cannot send a stale snapshot.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createSessionController } from '@/features/chat/session-controller'
import { RealGateway } from '@/gateway/real/real-gateway'
import { MemorySecretStore } from '@/gateway/real/secrets'

import { FakeWebSocket, fakeSocketFactory, flush, installFakeWebSocket } from '@test/fake-gateway/fake-websocket'

import { memoryOutbox } from '../fake-gateway/memory-outbox'

const originalWebSocket = (globalThis as { WebSocket?: unknown }).WebSocket

afterEach(() => {
  ;(globalThis as { WebSocket?: unknown }).WebSocket = originalWebSocket
})

const ID = 'srq-0000000000b7'
const APPROVAL = { session_id: 's1', request_id: 'ap7', command: 'rm -rf build', choices: ['once', 'session', 'always', 'deny'] }
/** What Hermes still lists for the session; the stale snapshots keep listing the answered request. */
const OPEN = [{ id: ID, method: 'approval', params: APPROVAL }]

function backend(method: string): unknown {
  switch (method) {
    case 'session.list':
      return { sessions: [] }
    case 'session.create':
      return { session_id: 's1', stored_session_id: 'st1', message_count: 0, messages: [], info: {} }
    case 'session.title':
      return { title: 'Bot Chat' }
    case 'session.activate':
      return { session_id: 's1', session_key: 'st1', status: 'waiting', running: false, message_count: 0, messages: [], messages_omitted: true, info: {}, open_requests: OPEN }
    case 'session.events.since':
      return { events: [], latest_seq: 0, truncated: false, count: 0, epoch: 'epoch-fake', open_requests: OPEN }
    default:
      return {}
  }
}

describe('an answered approval and a stale open_requests', () => {
  it('keeps the card answered on the same socket, and reopens it on a new one', async () => {
    installFakeWebSocket({ onRequest: backend })
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ profiles: [] }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch
    const gateway = new RealGateway({ connectionId: 'c1', baseUrl: 'http://gw.local', secrets: new MemorySecretStore(), fetchImpl, socketFactory: fakeSocketFactory })
    await gateway.login({ mode: 'token', token: 'tok-1' })
    const controller = createSessionController({ port: gateway, profile: 'thijs', connectionId: 'c1', outbox: memoryOutbox() })
    await controller.open()
    const card = () => controller.getView().state.items.find(i => i.kind === 'approval' && i.requestId === ID)
    const ws = FakeWebSocket.instances.at(-1)!

    ws.serverRequest(ID, 'approval', APPROVAL)
    await flush()
    expect(card()).toMatchObject({ state: 'pending' })
    await controller.answerApproval(ID, 'once')
    expect(card()).toMatchObject({ state: 'resolved', choice: 'once' })

    // The reconnect's activate, sent before the tap, answers after it.
    await gateway.sessions.activate('s1')
    await flush()
    expect(card()).toMatchObject({ state: 'resolved', choice: 'once' })
    expect(ws.sent.filter(f => f.id === ID)).toEqual([{ jsonrpc: '2.0', id: ID, result: { choice: 'once' } }])

    // A new socket: the answer may have died with the old one, so Hermes's listing counts again.
    ws.serverClose(1006)
    await controller.reconnect()
    await flush(20)
    expect(FakeWebSocket.instances.length).toBeGreaterThan(1)
    expect(card()).toMatchObject({ state: 'pending' })
    controller.close()
    gateway.disconnectAll()
  })
})
