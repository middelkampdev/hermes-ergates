/**
 * Scenario: the socket drops mid-chat and comes back.
 *
 * The backend parks a disconnected session's transport on a drop sink, so a
 * reconnect that only replays leaves the socket open and permanently silent.
 * Every reconnect must call `session.activate` FIRST (the transport rebind).
 * Its `open_requests` bring back the approval and clarify requests Hermes
 * still waits on.
 */
import { describe, expect, it } from 'vitest'

import { createSessionController } from '@/features/chat/session-controller'
import type { GatewayEventFrame } from '@/gateway/types'

import { flush } from '@test/fake-gateway/fake-websocket'
import sessionCreate from '@test/fixtures/session-create.json'

import { FakeGateway, type FakeScript } from '../fake-gateway/fake-gateway'
import { memoryOutbox } from '../fake-gateway/memory-outbox'

const noSleep = async (): Promise<void> => undefined

describe('reconnect rebind', () => {
  it('activates before replaying and restores the pending approval card', async () => {
    // Hermes wrote the request while the socket was detached, so it reaches the
    // phone only through `open_requests` (server.py:781-794).
    const script: FakeScript = {
      activate: {
        open_requests: [{
          id: 'srq-0000000000a1',
          method: 'approval',
          params: { session_id: sessionCreate.session_id, request_id: 'ap1', command: 'rm -rf build', description: 'dangerous command', choices: ['once', 'session', 'always', 'deny'] }
        }]
      }
    }
    const gateway = new FakeGateway(script)
    const controller = createSessionController({ port: gateway, profile: 'thijs', connectionId: 'c-test', outbox: memoryOutbox() })
    await controller.open()
    const conn = gateway.connectionFor('thijs')
    expect(controller.getView().state.items.some(i => i.kind === 'approval')).toBe(false)

    conn.simulateDrop()
    await flush(20)

    const rebind = conn.methods().indexOf('session.activate')
    const replay = conn.methods().indexOf('session.events.since')
    expect(rebind).toBeGreaterThanOrEqual(0)
    expect(replay).toBeGreaterThan(rebind)
    expect(gateway.calls.activate).toBe(1)
    expect(controller.getView().state.items.find(i => i.kind === 'approval')).toMatchObject({ requestId: 'srq-0000000000a1', state: 'pending' })
  })

  it('retries a 4009 "settling" activate once, then rebinds', async () => {
    const gateway = new FakeGateway({ activateSettling: 1 })
    const controller = createSessionController({ port: gateway, profile: 'thijs', connectionId: 'c-test', outbox: memoryOutbox(), sleep: noSleep })
    await controller.open()
    const conn = gateway.connectionFor('thijs')

    conn.simulateDrop()
    await flush(20)

    expect(gateway.calls.activate).toBe(2)
    expect(conn.methods().filter(m => m === 'session.activate')).toHaveLength(2)
    expect(conn.methods().indexOf('session.events.since')).toBeGreaterThan(conn.methods().lastIndexOf('session.activate'))
  })

  it('restores the streaming buffer from the inflight turn instead of losing the answer', async () => {
    const script: FakeScript = {
      onSubmit: () => [
        { type: 'message.start', seq: 1 },
        { type: 'message.delta', seq: 2, payload: { text: 'half ' } }
      ] as GatewayEventFrame[],
      activate: { running: true, status: 'streaming', inflight: { user: 'ping', assistant: 'half an answer', streaming: true } }
    }
    const gateway = new FakeGateway(script)
    const controller = createSessionController({ port: gateway, profile: 'thijs', connectionId: 'c-test', outbox: memoryOutbox() })
    await controller.open()
    await controller.send('ping')
    await flush(20)
    expect(controller.getView().state.live).toMatchObject({ streaming: true, assistantText: 'half ' })

    gateway.connectionFor('thijs').simulateDrop()
    await flush(20)

    expect(controller.getView().state.live).toMatchObject({ streaming: true, assistantText: 'half an answer' })
    expect(controller.getView().state.replay.needsHistoryRefetch).toBe(false)
    expect(gateway.calls.history).toBe(0)
  })

  it('reads durable history when the turn ended while the socket was down', async () => {
    const script: FakeScript = {
      onSubmit: () => [
        { type: 'message.start', seq: 1 },
        { type: 'message.delta', seq: 2, payload: { text: 'half ' } }
      ] as GatewayEventFrame[]
    }
    const gateway = new FakeGateway(script)
    const controller = createSessionController({ port: gateway, profile: 'thijs', connectionId: 'c-test', outbox: memoryOutbox() })
    await controller.open()
    await controller.send('ping')
    await flush(20)

    gateway.connectionFor('thijs').simulateDrop()
    await flush(20)

    // activate reports running:false: the completion frame was lost with the
    // socket, so the durable transcript is the only place the answer exists.
    // The reducer asks for it and the controller reads it at once.
    expect(controller.getView().state.live.streaming).toBe(false)
    expect(gateway.calls.history).toBe(1)
    expect(controller.getView().state.replay.needsHistoryRefetch).toBe(false)
  })
})
