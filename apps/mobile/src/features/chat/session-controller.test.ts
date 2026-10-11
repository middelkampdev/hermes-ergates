/**
 * Unit tests for the controller paths the scenario tests do not reach: open
 * failures, a reaped session, terminal socket failures and the small commands.
 * The scenarios in test/scenarios cover streaming, the outbox and reconnects.
 */
import { describe, expect, it, vi } from 'vitest'

import { GatewayError } from '@/gateway/errors'

import { flush } from '@test/fake-gateway/fake-websocket'
import { FakeGateway } from '@test/fake-gateway/fake-gateway'
import { memoryOutbox } from '@test/fake-gateway/memory-outbox'

import { createSessionController } from './session-controller'

function controllerFor(gateway: FakeGateway, extra: { allowDevInject?: boolean } = {}) {
  return createSessionController({ port: gateway, profile: 'thijs', connectionId: 'c-test', outbox: memoryOutbox(), ...extra })
}

describe('createSessionController', () => {
  it('starts in the opening phase with the initial reducer state', () => {
    const controller = controllerFor(new FakeGateway())
    expect(controller.getView()).toMatchObject({ phase: 'opening', openError: null, connectionError: null, needsReauth: false })
    expect(controller.getView().state.items).toEqual([])
  })

  it('reports an expired sign-in at open as a terminal failure', async () => {
    const gateway = new FakeGateway()
    vi.spyOn(gateway, 'connect').mockRejectedValue(new GatewayError('unauthorized', 'Sign in again.', { code: 401 }))
    const controller = controllerFor(gateway)

    await controller.open()

    expect(controller.getView().phase).toBe('error')
    expect(controller.getView().openError).toBeTruthy()
    expect(controller.getView().needsReauth).toBe(true)
  })

  it('reports any other open failure without asking for a new sign-in', async () => {
    const gateway = new FakeGateway()
    vi.spyOn(gateway, 'connect').mockRejectedValue(new GatewayError('network', 'The gateway could not be reached.'))
    const controller = controllerFor(gateway)

    await controller.open()

    expect(controller.getView().phase).toBe('error')
    expect(controller.getView().needsReauth).toBe(false)
  })

  it('re-opens the chat when a reconnect finds the session reaped', async () => {
    const gateway = new FakeGateway()
    const controller = controllerFor(gateway)
    await controller.open()
    expect(gateway.calls.title).toHaveLength(1)

    // The gateway restarted and forgot the live session id.
    await gateway.sessions.close(controller.getView().state.liveSessionId ?? '')
    await controller.reconnect()
    await flush(20)

    expect(gateway.calls.title).toHaveLength(2)
    expect(controller.getView().phase).toBe('ready')
    expect(controller.getView().state.liveSessionId).toBe('live0001')
  })

  it('never re-opens a closed controller when a reconnect resolves to a reaped session late', async () => {
    const gateway = new FakeGateway()
    const connectSpy = vi.spyOn(gateway, 'connect')
    const controller = controllerFor(gateway)
    await controller.open()
    expect(gateway.calls.title).toHaveLength(1)
    expect(connectSpy).toHaveBeenCalledTimes(1)

    // The gateway restarted and forgot the live session id.
    await gateway.sessions.close(controller.getView().state.liveSessionId ?? '')

    // Hold `session.activate` in flight so the test can close the chat while
    // the resync is still resolving.
    let release = (): void => {}
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    vi.spyOn(gateway.sessions, 'activate').mockImplementation(async () => {
      await gate
      throw new GatewayError('not_found', 'The session was not found.')
    })

    const pending = controller.reconnect()
    await flush(1)
    // The user left the chat while the reconnect was still in flight.
    controller.close()
    release()
    await pending
    await flush(20)

    // A cancelled reconnect must never re-open the chat: no second `connect`,
    // no second `session.title` mint, and so no second shared-outbox flush.
    expect(gateway.calls.title).toHaveLength(1)
    expect(connectSpy).toHaveBeenCalledTimes(1)
  })

  it('offers a new sign-in when the socket closes for good', async () => {
    const gateway = new FakeGateway()
    const controller = controllerFor(gateway)
    await controller.open()
    const conn = gateway.connectionFor('thijs')

    conn.lastError = { kind: 'unauthorized', message: 'Your sign-in expired.', terminal: true, code: 4401 }
    conn.simulateOffline()

    expect(controller.getView().connectionError).toBe('Your sign-in expired.')
    expect(controller.getView().needsReauth).toBe(true)
  })

  it('clears the connection failure after a successful resync', async () => {
    const gateway = new FakeGateway()
    const controller = controllerFor(gateway)
    await controller.open()
    const conn = gateway.connectionFor('thijs')
    conn.lastError = { kind: 'network', message: 'The connection dropped.', terminal: false }
    conn.simulateOffline()
    expect(controller.getView().connectionError).toBe('The connection dropped.')

    conn.lastError = null
    conn.simulateOnline()
    await flush(20)

    expect(controller.getView().connectionError).toBeNull()
  })

  it('refuses to send before the chat is open', async () => {
    const controller = controllerFor(new FakeGateway())

    await controller.send('too early')

    expect(controller.getView().state.lastError).toBe('The chat is not open yet.')
  })

  it('says so when Stop finds no running turn', async () => {
    const gateway = new FakeGateway()
    vi.spyOn(gateway.sessions, 'interrupt').mockResolvedValue({ status: 'not_interrupted' })
    const controller = controllerFor(gateway)
    await controller.open()

    await controller.stop()

    expect(controller.getView().state.lastError).toBe('There was no running turn to stop.')
  })

  it('dismisses a clarify card with free text', async () => {
    const gateway = new FakeGateway()
    const respond = vi.spyOn(gateway.sessions, 'respondClarify')
    const controller = controllerFor(gateway)
    await controller.open()
    const live = controller.getView().state.liveSessionId ?? ''
    gateway.connectionFor('thijs').serverRequest({
      id: 'srq-0000000000c1',
      method: 'clarify',
      params: { session_id: live, questions: [{ qid: 'q0', question: 'Tea or coffee?', choices: ['A) tea', 'B) coffee'], multi_select: false }] }
    })

    await controller.dismissClarify('srq-0000000000c1', 'water, please')

    expect(respond).toHaveBeenCalledWith({ session_id: live, request_id: 'srq-0000000000c1', answers: { q0: 'water, please' } })
    expect(controller.getView().state.items.find(i => i.kind === 'clarify')).toMatchObject({ requestId: 'srq-0000000000c1', state: 'dismissed' })
  })

  it('keeps a clarify card open when the answer fails', async () => {
    const gateway = new FakeGateway()
    vi.spyOn(gateway.sessions, 'respondClarify').mockRejectedValue(new GatewayError('rpc', 'The gateway rejected the request.', { code: 4002 }))
    const controller = controllerFor(gateway)
    await controller.open()
    const live = controller.getView().state.liveSessionId ?? ''
    gateway.connectionFor('thijs').serverRequest({
      id: 'srq-0000000000c1',
      method: 'clarify',
      params: { session_id: live, questions: [{ qid: 'q0', question: 'Tea or coffee?', choices: ['A) tea', 'B) coffee'], multi_select: false }] }
    })

    await controller.answerClarify('srq-0000000000c1', { q0: 'A' })

    expect(controller.getView().state.items.find(i => i.kind === 'clarify')).toMatchObject({ requestId: 'srq-0000000000c1', state: 'pending' })
  })

  it('injects a development frame only when allowed', async () => {
    const frame = { type: 'message.complete', payload: { text: 'injected', status: 'complete' } } as const
    const locked = controllerFor(new FakeGateway())
    await locked.open()
    locked.devInjectEvent(frame)
    expect(locked.getView().state.items.some(i => i.kind === 'assistant' && i.text === 'injected')).toBe(false)

    const open = controllerFor(new FakeGateway(), { allowDevInject: true })
    await open.open()
    open.devInjectEvent(frame)
    expect(open.getView().state.items.some(i => i.kind === 'assistant' && i.text === 'injected')).toBe(true)
  })

  it('does not notify subscribers when a frame changes nothing', async () => {
    const gateway = new FakeGateway()
    const controller = controllerFor(gateway)
    await controller.open()
    const listener = vi.fn()
    controller.subscribe(listener)
    const before = controller.getView()

    // Another session's frame: the reducer returns the same state.
    gateway.connectionFor('thijs').emit({ type: 'message.delta', session_id: 'someone-else', seq: 7, payload: { text: 'not ours' } })

    expect(listener).toHaveBeenCalledTimes(0)
    expect(controller.getView()).toBe(before)
  })

  it('clears the error line on request', async () => {
    const controller = controllerFor(new FakeGateway())
    await controller.send('too early')
    expect(controller.getView().state.lastError).not.toBeNull()

    controller.clearError()

    expect(controller.getView().state.lastError).toBeNull()
  })
})
