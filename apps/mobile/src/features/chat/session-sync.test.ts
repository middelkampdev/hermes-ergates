import { describe, expect, it, vi } from 'vitest'

import { GatewayError } from '@/gateway/errors'
import type { GatewayConnection, GatewayPort } from '@/gateway/port'
import type { ActivateResult, ReplayResult } from '@/gateway/types'

import type { SessionAction } from './session-reducer'
import { activateSession, resyncSession, SETTLING_RETRY_MS } from './session-sync'

const LIVE = 'live0001'

const activateResult = (over: Partial<ActivateResult> = {}): ActivateResult => ({
  session_id: LIVE,
  session_key: 'stored-1',
  status: 'idle',
  running: false,
  message_count: 0,
  messages: [],
  messages_omitted: true,
  info: {},
  ...over
})

const replayResult = (): ReplayResult => ({ events: [], latest_seq: 7, truncated: false, count: 0, epoch: 'epoch-1' })

function harness(over: { activate?: () => Promise<ActivateResult>; replay?: () => Promise<ReplayResult> } = {}) {
  const order: string[] = []
  const actions: SessionAction[] = []
  const activate = over.activate ?? (async () => activateResult())
  const port = {
    sessions: {
      activate: vi.fn(async (id: string, opts?: { omit_messages?: boolean }) => {
        order.push(`session.activate ${id} omit=${String(opts?.omit_messages)}`)
        return activate()
      })
    }
  } as unknown as GatewayPort
  const connection = {
    state: 'open' as const,
    replay: vi.fn(async (id: string, lastSeen: number) => {
      order.push(`session.events.since ${id} ${lastSeen}`)
      return over.replay ? over.replay() : replayResult()
    })
  } as unknown as GatewayConnection
  return { order, actions, port, connection, dispatch: (a: SessionAction) => actions.push(a) }
}

describe('activateSession', () => {
  it('asks for the transport rebind without the transcript', async () => {
    const h = harness()
    await activateSession(h.port, LIVE)
    expect(h.order).toEqual([`session.activate ${LIVE} omit=true`])
  })

  it('retries once after a 4009 "settling" rejection', async () => {
    let calls = 0
    const h = harness({
      activate: async () => {
        calls += 1
        if (calls === 1) {
          throw new GatewayError('busy', 'session disconnect interrupt settling', { code: 4009 })
        }
        return activateResult({ running: true })
      }
    })
    const slept: number[] = []
    const result = await activateSession(h.port, LIVE, async ms => {
      slept.push(ms)
    })
    expect(calls).toBe(2)
    expect(slept).toEqual([SETTLING_RETRY_MS])
    expect(result.running).toBe(true)
  })

  it('does not retry any other rejection', async () => {
    let calls = 0
    const h = harness({
      activate: async () => {
        calls += 1
        throw new GatewayError('rpc', 'nope', { code: 5000 })
      }
    })
    await expect(activateSession(h.port, LIVE, async () => undefined)).rejects.toThrow('nope')
    expect(calls).toBe(1)
  })
})

describe('resyncSession', () => {
  it('rebinds the transport BEFORE replaying, and hands the open requests to the reducer', async () => {
    const open = [{ id: 'srq-0000000000a1', method: 'approval', params: { session_id: LIVE, request_id: 'ap1', command: 'rm -rf build' } }]
    const h = harness({
      activate: async () =>
        activateResult({
          running: true,
          status: 'waiting',
          inflight: { user: 'do it', assistant: 'working', streaming: true },
          open_requests: open
        })
    })
    const result = await resyncSession({ port: h.port, connection: h.connection, liveSessionId: LIVE, lastSeq: () => 3, dispatch: h.dispatch })

    // `session.events.since` reads an in-process ring and needs no transport;
    // only activate/resume/prompt.submit rebind it. Replaying first leaves the
    // socket open and silent for everything that comes after.
    expect(h.order).toEqual([`session.activate ${LIVE} omit=true`, `session.events.since ${LIVE} 3`])
    expect(result).toMatchObject({ activated: true, replayed: true, stale: false })
    // The connection itself delivers each open request again before activate
    // resolves (json-rpc-channel.ts:474-483); the activate result only tells
    // the reducer which cards Hermes still waits on.
    expect(h.actions.map(a => a.type)).toEqual(['session/activated', 'replay/result'])
    expect(h.actions[0]).toMatchObject({ type: 'session/activated', result: { open_requests: open } })
  })

  it('reports a stale session id instead of replaying into a chat that is gone', async () => {
    const h = harness({
      activate: async () => {
        throw new GatewayError('not_found', 'session not found', { code: 4007 })
      }
    })
    const result = await resyncSession({ port: h.port, connection: h.connection, liveSessionId: LIVE, lastSeq: () => 0, dispatch: h.dispatch, sleep: async () => undefined })
    expect(result.stale).toBe(true)
    expect(result.activated).toBe(false)
    expect(result.error).toBeTruthy()
  })

  it('still replays when activate fails for another reason', async () => {
    const h = harness({
      activate: async () => {
        throw new GatewayError('rpc', 'transient', { code: 5000 })
      }
    })
    const result = await resyncSession({ port: h.port, connection: h.connection, liveSessionId: LIVE, lastSeq: () => 0, dispatch: h.dispatch, sleep: async () => undefined })
    expect(result).toMatchObject({ activated: false, replayed: true, stale: false })
    expect(h.actions.map(a => a.type)).toEqual(['replay/result'])
  })
})
