/**
 * Scenario: Hermes v0.21.6 asks for an approval or a clarify answer with a
 * server-to-client request (tui_gateway/server_requests.py) and waits for one
 * response frame with the request's id.
 */
import { beforeEach, describe, expect, it } from 'vitest'

import { createSessionController, type SessionController } from '@/features/chat/session-controller'

import { flush } from '@test/fake-gateway/fake-websocket'

import { FakeGateway, type FakeConnection } from '../fake-gateway/fake-gateway'
import { memoryOutbox } from '../fake-gateway/memory-outbox'

describe('approval and clarify requests', () => {
  let controller: SessionController
  let conn: FakeConnection
  let live: string
  const card = (id: string) => controller.getView().state.items.find(i => (i.kind === 'approval' || i.kind === 'clarify') && i.requestId === id)

  beforeEach(async () => {
    const gateway = new FakeGateway()
    controller = createSessionController({ port: gateway, profile: 'thijs', connectionId: 'c-test', outbox: memoryOutbox() })
    await controller.open()
    conn = gateway.connectionFor('thijs')
    const id = controller.getView().state.liveSessionId
    if (!id) throw new Error('no live session id')
    live = id
  })

  it('answers an approval request with one {choice} response frame', async () => {
    conn.serverRequest({ id: 'srq-000000000001', method: 'approval', params: { session_id: live, request_id: 'ap1', command: 'rm -rf /tmp/x', choices: ['once', 'session', 'always', 'deny'] } })
    expect(card('srq-000000000001')).toMatchObject({ kind: 'approval', state: 'pending' })
    await controller.answerApproval('srq-000000000001', 'once')
    expect(conn.responses).toEqual([{ id: 'srq-000000000001', result: { choice: 'once' } }])
    expect(card('srq-000000000001')).toMatchObject({ state: 'resolved', choice: 'once' })
  })

  it('answers a clarify card with one {answers} frame, a typed answer and a skipped question included', async () => {
    const questions = [{ qid: 'q0', question: 'Tea or coffee?', choices: ['A) tea', 'B) coffee'] }, { qid: 'q1', question: 'Sugar?', choices: ['A) yes', 'B) no'] }]
    conn.serverRequest({ id: 'srq-000000000002', method: 'clarify', params: { session_id: live, questions } })
    conn.serverRequest({ id: 'srq-000000000003', method: 'clarify', params: { session_id: live, questions } })
    await controller.answerClarify('srq-000000000002', { q0: 'A', q1: 'B' })
    await controller.answerClarify('srq-000000000003', { q0: 'Water, please', q1: null })
    expect(conn.responses).toEqual([
      { id: 'srq-000000000002', result: { answers: { q0: 'A', q1: 'B' } } },
      { id: 'srq-000000000003', result: { answers: { q0: 'Water, please', q1: null } } }
    ])
  })

  it('skips a clarify card with one response frame without answers, and keeps the answers another client locked', async () => {
    const questions = [{ qid: 'q0', question: 'Tea or coffee?', choices: ['A) tea', 'B) coffee'] }, { qid: 'q1', question: 'Sugar?', choices: ['A) yes', 'B) no'] }]
    conn.serverRequest({ id: 'srq-000000000007', method: 'clarify', params: { session_id: live, questions, answers: { q0: 'A' } } })
    await controller.answerClarify('srq-000000000007', null)
    // Hermes ends a set answered without `answers` as cancelled and keeps the locked answers (server_requests.py:287-288).
    expect(conn.responses).toEqual([{ id: 'srq-000000000007', result: {} }])
    expect(card('srq-000000000007')).toMatchObject({ state: 'skipped', answers: { q0: 'A' } })
  })

  it('sends one frame for a double tap, and keeps a Skip that cannot be sent open with its error', async () => {
    const questions = [{ qid: 'q0', question: 'Tea or coffee?', choices: ['A) tea', 'B) coffee'] }]
    conn.serverRequest({ id: 'srq-000000000008', method: 'clarify', params: { session_id: live, questions } })
    await Promise.all([controller.answerClarify('srq-000000000008', null), controller.answerClarify('srq-000000000008', null)])
    await controller.answerClarify('srq-000000000008', { q0: 'A' })
    expect(conn.responses).toEqual([{ id: 'srq-000000000008', result: {} }])
    expect(controller.getView().state.lastError).toBeFalsy()

    conn.serverRequest({ id: 'srq-000000000009', method: 'clarify', params: { session_id: live, questions } })
    conn.simulateOffline()
    await controller.answerClarify('srq-000000000009', null)
    expect(card('srq-000000000009')).toMatchObject({ state: 'pending', error: 'No connection to the gateway.' })
  })

  it('expires the card Hermes cancels and keeps one card for a request re-delivered after a reconnect', async () => {
    conn.serverRequest({ id: 'srq-000000000004', method: 'approval', params: { session_id: live, request_id: 'ap4' } })
    conn.serverRequest({ id: 'srq-000000000005', method: 'approval', params: { session_id: live, request_id: 'ap5' } })
    conn.cancelRequest('srq-000000000005', 'timeout')
    conn.simulateDrop()
    await flush(20)
    expect(conn.methods()).toContain('session.activate')
    expect(controller.getView().state.items.filter(i => i.kind === 'approval')).toMatchObject([{ requestId: 'srq-000000000004', state: 'pending' }, { requestId: 'srq-000000000005', state: 'expired' }])
  })

  it('keeps the card open and says so when the answer cannot be sent', async () => {
    conn.serverRequest({ id: 'srq-000000000006', method: 'approval', params: { session_id: live, request_id: 'ap6' } })
    conn.simulateOffline()
    await controller.answerApproval('srq-000000000006', 'once')
    expect(conn.responses).toEqual([])
    expect(card('srq-000000000006')).toMatchObject({ state: 'pending' })
    expect(controller.getView().state.lastError).toBe('No connection to the gateway.')
  })
})
