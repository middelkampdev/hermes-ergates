/**
 * Scenario: Hermes raises an approval while the reconnect's `session.activate`
 * is on the wire.
 *
 * Hermes takes the activate snapshot, then raises a new request, and the
 * request frame reaches the phone before the activate answer. That snapshot
 * cannot list the new request, while Hermes waits on it for the whole
 * `approvals.timeout`. Only a card that was already pending when activate went
 * out may expire because the snapshot leaves it out.
 *
 * This runs the real adapter over the WebSocket double, which writes the
 * request frame to the socket ahead of the activate answer.
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

/** Pending before the reconnect; its `request.cancel` was lost, so no snapshot lists it any more. */
const OLD = 'srq-0000000000c1'
/** Raised after Hermes took the activate snapshot. */
const NEW = 'srq-0000000000c2'
const approval = (requestId: string) => ({ session_id: 's1', request_id: requestId, command: 'rm -rf build', choices: ['once', 'session', 'always', 'deny'] })

describe('a request raised while session.activate is on the wire', () => {
  it('keeps the new card pending and expires only the card the snapshot left out', async () => {
    let raceActivate = false
    installFakeWebSocket({
      onRequest: method => {
        switch (method) {
          case 'session.list':
            return { sessions: [] }
          case 'session.create':
            return { session_id: 's1', stored_session_id: 'st1', message_count: 0, messages: [], info: {} }
          case 'session.title':
            return { title: 'Bot Chat' }
          case 'session.activate':
            if (raceActivate) {
              FakeWebSocket.instances.at(-1)!.serverRequest(NEW, 'approval', approval('ap-new'))
            }
            return { session_id: 's1', session_key: 'st1', status: 'waiting', running: true, message_count: 0, messages: [], messages_omitted: true, info: {} }
          case 'session.events.since':
            return { events: [], latest_seq: 0, truncated: false, count: 0, epoch: 'epoch-fake', open_requests: raceActivate ? [{ id: NEW, method: 'approval', params: approval('ap-new') }] : [] }
          default:
            return {}
        }
      }
    })
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ profiles: [] }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch
    const gateway = new RealGateway({ connectionId: 'c1', baseUrl: 'http://gw.local', secrets: new MemorySecretStore(), fetchImpl, socketFactory: fakeSocketFactory })
    await gateway.login({ mode: 'token', token: 'tok-1' })
    const controller = createSessionController({ port: gateway, profile: 'thijs', connectionId: 'c1', outbox: memoryOutbox() })
    await controller.open()
    const card = (id: string) => {
      const item = controller.getView().state.items.find(i => i.kind === 'approval' && i.requestId === id)
      return item?.kind === 'approval' ? item : undefined
    }
    const seen: string[] = []
    controller.subscribe(() => {
      const state = card(NEW)?.state
      if (state && seen.at(-1) !== state) {
        seen.push(state)
      }
    })

    FakeWebSocket.instances.at(-1)!.serverRequest(OLD, 'approval', approval('ap-old'))
    await flush()
    expect(card(OLD)).toMatchObject({ state: 'pending' })

    raceActivate = true
    await controller.reconnect()
    await flush(20)

    expect(card(OLD)).toMatchObject({ state: 'expired' })
    expect(card(NEW)).toMatchObject({ state: 'pending' })
    // Not even for a moment: an expired card cannot be answered.
    expect(seen).toEqual(['pending'])
    controller.close()
    gateway.disconnectAll()
  })
})
