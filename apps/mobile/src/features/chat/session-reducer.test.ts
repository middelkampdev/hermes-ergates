import { describe, expect, it } from 'vitest'

import type { ActivateResult, GatewayEventFrame, HistoryMessage } from '@/gateway/types'
import eventsSender from '@test/fixtures/agent-traffic/events-sender.json'
import historyFixture from '@test/fixtures/history.json'
import historyReceiver from '@test/fixtures/agent-traffic/history-receiver.json'
import historySender from '@test/fixtures/agent-traffic/history-sender.json'
import liveJson from '@test/fixtures/agent-traffic/receipt-live-json.json'
import receiptBatchThree from '@test/fixtures/agent-traffic/receipt-batch-three.json'
import receiptCliCut from '@test/fixtures/agent-traffic/receipt-cli-cut.json'
import receiptWatchMatch from '@test/fixtures/agent-traffic/receipt-watch-match.json'
import clarifyRequest from '@test/fixtures/clarify-request.json'
import turnClarify from '@test/fixtures/turn-clarify.json'
import turnPong from '@test/fixtures/turn-pong.json'

import { parseReceiptRow } from './agent-traffic/receipt'
import { historyToItems, mergeHistory, type ChatItem } from './history'
import { initialSessionState, localTurnPending, pendingRequestIds, sessionReducer, type SessionAction, type SessionState } from './session-reducer'

const liveReceiptParse = parseReceiptRow(liveJson.text)
if (liveReceiptParse.kind !== 'receipts') throw new Error('receipt-live-json fixture did not parse as a receipt')
const liveReceipt = liveReceiptParse.receipts[0]!

/** What v0.21.6 sends in `status.update {kind: "process"}` for a completion (session_notifications.py:546-552). */
const TITLE = 'Background Process Finished: /opt/data/hermes/hermes-agent/venv/bin/python /opt/data/hermes/hermes-agent/tools/bot_mo...'
/** What v0.21.6 sends there for a finished subagent (tools/process_registry_notifications.py:320-321; session_notifications.py:546-552). */
const SUBAGENT_TITLE = 'Subagent Task Completed: Review the release notes'
/** The row Hermes v0.21.6 closes a failed turn with (agent/turn_failure_copy.py:39-41, :48; agent/conversation_loop.py:1848-1850). */
const FAILED_TURN_NOTICE = 'Your request was not processed. Send it again if you still want me to carry it out.'

const LIVE = 'live0001'
const STORED = '20260913_170000_fixture'

function bound(): SessionState {
  return sessionReducer(initialSessionState, { type: 'session/bound', liveSessionId: LIVE, storedSessionId: STORED, epoch: 'epoch-fixture-1' })
}

function run(state: SessionState, actions: SessionAction[]): SessionState {
  return actions.reduce(sessionReducer, state)
}

const ev = (event: Partial<GatewayEventFrame> & { type: string }): SessionAction => ({ type: 'event', event: { session_id: LIVE, ...event } })

const activateResult = (over: Partial<ActivateResult> = {}): ActivateResult => ({
  session_id: LIVE,
  session_key: STORED,
  status: 'idle',
  running: false,
  message_count: 0,
  messages: [],
  messages_omitted: true,
  info: {},
  ...over
})

const req = (id: string, method: string, params: Record<string, unknown>, replayed = false, sid = LIVE): SessionAction =>
  ({ type: 'request/received', request: { id, method, params: { session_id: sid, ...params }, replayed } })
const APPROVAL = { request_id: 'ap1', command: 'rm -rf build', choices: ['once', 'deny'] }
const clarify = (id: string) => req(id, 'clarify', { questions: [{ qid: 'q0', question: `${id}?` }] })

describe('recorded turns', () => {
  it('renders the pong turn as one user bubble and one assistant bubble', () => {
    const start = run(bound(), [{ type: 'submit/started', localId: 'l1', text: 'Reply with exactly the single word: pong', at: 1 }, { type: 'submit/acknowledged', localId: 'l1' }])
    const end = run(start, (turnPong as GatewayEventFrame[]).map(e => ({ type: 'event', event: e }) as SessionAction))
    const bubbles = end.items.filter(i => i.kind === 'user' || i.kind === 'assistant')
    expect(bubbles).toHaveLength(2)
    expect(bubbles[1]).toMatchObject({ kind: 'assistant', text: 'pong' })
    expect(end.live.streaming).toBe(false)
    expect(end.usage?.total).toBe(11898)
    expect(end.replay.lastSeq).toBe(11)
    // The turn is sealed locally: `session.history` returns the WHOLE transcript
    // (no pagination), so a forever chat must not refetch it after every reply.
    expect(end.replay.needsHistoryRefetch).toBe(false)
    // The sealed user row is durable now, so a later refetch replaces it instead
    // of re-labelling it "unconfirmed".
    expect(bubbles[0]).toMatchObject({ kind: 'user', delivery: 'acknowledged' })
    expect((bubbles[0] as { localId?: string }).localId).toBeUndefined()
  })

  it('renders the clarify turn with a pending card, then answers it', () => {
    // v0.21.6 asks the question as a server request, not as an event in the turn (server.py:2288-2289).
    const events = (turnClarify as GatewayEventFrame[]).map(e => ({ type: 'event', event: e }) as SessionAction)
    const asked: SessionAction = { type: 'request/received', request: { id: clarifyRequest.id, method: clarifyRequest.method, params: clarifyRequest.params, replayed: false } }
    const end = run(bound(), [...events.slice(0, -1), asked, ...events.slice(-1)])
    const card = end.items.find(i => i.kind === 'clarify')
    expect(card).toMatchObject({ kind: 'clarify', requestId: 'srq-5c1e9a0b7d42', state: 'pending' })
    if (card?.kind !== 'clarify') throw new Error('no card')
    expect(card.questions[0]?.choices).toEqual(['A) tea (Recommended)', 'B) coffee'])
    const tools = end.items.filter(i => i.kind === 'tool')
    expect(tools).toHaveLength(1)
    expect(tools[0]).toMatchObject({ name: 'clarify', done: false })
    const answered = sessionReducer(end, { type: 'clarify/responded', requestId: 'srq-5c1e9a0b7d42', answers: { q0: 'A' } })
    expect(answered.items.find(i => i.kind === 'clarify')).toMatchObject({ state: 'answered', answers: { q0: 'A' } })
    const skipped = sessionReducer(end, { type: 'clarify/responded', requestId: 'srq-5c1e9a0b7d42', answers: null })
    const skippedCard = skipped.items.find(i => i.kind === 'clarify')
    expect(skippedCard).toMatchObject({ state: 'skipped' })
    expect(skippedCard).not.toHaveProperty('answers.q0')
    expect(skipped.revision).toBe(end.revision + 1)
  })
})

describe('streaming rules', () => {
  it('appends deltas, keeps interim out of the stream, complete seals with the full text', () => {
    const s = run(bound(), [ev({ type: 'message.start', seq: 1 }), ev({ type: 'message.delta', seq: 2, payload: { text: 'po' } }), ev({ type: 'message.delta', seq: 3, payload: { text: 'ng' } })])
    expect(s.live).toMatchObject({ streaming: true, assistantText: 'pong' })
    // Commentary alongside a tool call is its own row: overwriting the buffer
    // threw away the answer so far and appended the rest to the commentary.
    const interim = sessionReducer(s, ev({ type: 'message.interim', seq: 4, payload: { text: 'Let me check the file first.' } }))
    expect(interim.live.assistantText).toBe('pong')
    expect(interim.items.at(-1)).toMatchObject({ kind: 'commentary', text: 'Let me check the file first.' })
    const done = sessionReducer(interim, ev({ type: 'message.complete', seq: 5, payload: { text: 'final', status: 'complete' } }))
    expect(done.items.at(-1)).toMatchObject({ kind: 'assistant', text: 'final' })
    expect(done.live.assistantText).toBe('')
  })

  it('drops an interim whose text was already streamed as deltas', () => {
    const s = run(bound(), [
      ev({ type: 'message.start', seq: 1 }),
      ev({ type: 'message.delta', seq: 2, payload: { text: 'pong' } }),
      ev({ type: 'message.interim', seq: 3, payload: { text: 'pong', already_streamed: true } })
    ])
    expect(s.live.assistantText).toBe('pong')
    expect(s.items.filter(i => i.kind === 'commentary')).toHaveLength(0)
  })

  it('treats thinking.delta as a status line and reasoning as collapsed detail', () => {
    const s = run(bound(), [ev({ type: 'message.start', seq: 1 }), ev({ type: 'thinking.delta', seq: 2, payload: { text: 'formulating...' } }), ev({ type: 'reasoning.delta', seq: 3, payload: { text: 'Plan ' } }), ev({ type: 'reasoning.delta', seq: 4, payload: { text: 'B' } })])
    expect(s.live.statusLine).toBe('formulating...')
    expect(s.live.reasoningText).toBe('Plan B')
    const done = sessionReducer(s, ev({ type: 'message.complete', seq: 5, payload: { text: 'ok' } }))
    expect(done.items.at(-1)).toMatchObject({ kind: 'assistant', reasoning: 'Plan B' })
    expect(done.live.statusLine).toBeNull()
  })

  it('tracks tool start and completion by tool_id', () => {
    const s = run(bound(), [ev({ type: 'tool.start', seq: 1, payload: { tool_id: 't1', name: 'web_search', args: { q: 'x' } } })])
    expect(s.items[0]).toMatchObject({ kind: 'tool', toolId: 't1', done: false })
    const d = sessionReducer(s, ev({ type: 'tool.complete', seq: 2, payload: { tool_id: 't1', name: 'web_search', duration_s: 1.5, result: { hits: 3 } } }))
    expect(d.items).toHaveLength(1)
    expect(d.items[0]).toMatchObject({ done: true, durationS: 1.5, result: { hits: 3 } })
  })

  it('keeps the start frame arguments when the completion carries none', () => {
    const s = run(bound(), [ev({ type: 'tool.start', seq: 1, payload: { tool_id: 'call_1', name: 'message_agent', args: { target: 'kevin', message: 'hi' } } })])
    const d = sessionReducer(s, ev({ type: 'tool.complete', seq: 2, payload: { tool_id: 'call_1', name: 'message_agent', result: { status: 'sent' } } }))
    expect(d.items[0]).toMatchObject({ kind: 'tool', toolId: 'call_1', done: true, args: { target: 'kevin', message: 'hi' }, result: { status: 'sent' } })
  })

  it('lets a completion that carries arguments replace the start frame ones', () => {
    const s = run(bound(), [ev({ type: 'tool.start', seq: 1, payload: { tool_id: 'call_1', name: 'message_agent', args: { target: 'kevin', message: 'hi' } } })])
    const d = sessionReducer(s, ev({ type: 'tool.complete', seq: 2, payload: { tool_id: 'call_1', name: 'message_agent', args: { target: 'kevin', message: 'hi there' }, result: { status: 'sent' } } }))
    expect(d.items[0]).toMatchObject({ kind: 'tool', args: { target: 'kevin', message: 'hi there' } })
  })

  it('surfaces a failed completion using the payload the backend actually sends', () => {
    // prompt_turn.py:629-683: `error` + `recoverable` + `error_surface` on every
    // failed turn; `failure_reason` only alongside the billing descriptor.
    const s = run(bound(), [
      ev({ type: 'message.start', seq: 1 }),
      ev({
        type: 'message.complete',
        seq: 2,
        payload: { text: 'partial answer', status: 'error', error: 'upstream connect error or disconnect/reset before headers', recoverable: true, error_surface: { layer: 'streaming', code: 'stream_drop', retryable: true } }
      })
    ])
    expect(s.lastError).toBe('upstream connect error or disconnect/reset before headers')
    expect(s.items.at(-1)).toMatchObject({ kind: 'assistant', error: 'upstream connect error or disconnect/reset before headers', retryable: true })
    expect(s.live.streaming).toBe(false)
  })

  it('falls back to failure_reason on the billing-wall payload', () => {
    const s = run(bound(), [
      ev({ type: 'message.start', seq: 1 }),
      ev({ type: 'message.complete', seq: 2, payload: { text: 'x', status: 'error', failure_reason: 'billing', billing: { reason: 'billing' }, error_surface: { layer: 'billing', code: 'billing', retryable: false } } })
    ])
    expect(s.lastError).toBe('billing')
    expect(s.items.at(-1)).toMatchObject({ kind: 'assistant', retryable: false })
  })
})

describe('requests', () => {
  it('opens one card per request id, reopens an answered card Hermes delivers again, and ignores other sessions', () => {
    const s = run(bound(), [req('srq-000000000001', 'approval', APPROVAL), req('srq-000000000001', 'approval', APPROVAL, true), req('srq-000000000009', 'approval', APPROVAL, false, 'other')])
    expect(s.items.filter(i => i.kind === 'approval')).toMatchObject([{ requestId: 'srq-000000000001', state: 'pending' }])
    const again = run(s, [{ type: 'approval/responded', requestId: 'srq-000000000001', choice: 'once' }, req('srq-000000000001', 'approval', APPROVAL, true)])
    expect(again.items.filter(i => i.kind === 'approval')).toMatchObject([{ state: 'pending' }])
  })

  it('expires only the cancelled card, and every pending card session.activate no longer lists', () => {
    const s = run(bound(), [clarify('srq-00000000000a'), clarify('srq-00000000000b'), clarify('srq-00000000000c'),
      ev({ type: 'request.cancel', seq: 1, payload: { id: 'srq-00000000000a', method: 'clarify', reason: 'timeout' } }),
      { type: 'session/activated', result: activateResult({ open_requests: [{ id: 'srq-00000000000b', method: 'clarify', params: { session_id: LIVE } }] }), pendingWhenSent: ['srq-00000000000b', 'srq-00000000000c'] }])
    const cards = s.items.filter(i => i.kind === 'clarify')
    expect(cards).toMatchObject([{ state: 'expired' }, { state: 'pending', questions: [{ qid: 'q0', choices: [], multi_select: false }] }, { state: 'expired' }])
  })

  it('expires only the cards that were pending when activate went out', () => {
    const before = run(bound(), [clarify('srq-000000000012')])
    const pendingWhenSent = pendingRequestIds(before)
    // A live request reaches the phone just before the answer to an activate whose
    // snapshot Hermes took before it raised that request: the snapshot cannot list it.
    const s = run(before, [req('srq-000000000013', 'approval', APPROVAL), { type: 'session/activated', result: activateResult(), pendingWhenSent }])
    expect(s.items.filter(i => i.kind === 'clarify' || i.kind === 'approval')).toMatchObject([
      { requestId: 'srq-000000000012', state: 'expired' },
      { requestId: 'srq-000000000013', state: 'pending' }
    ])
  })

  it('expires every pending card a resume payload no longer lists', () => {
    const s = run(bound(), [clarify('srq-00000000000d'), req('srq-00000000000e', 'approval', APPROVAL),
      { type: 'session/resumed', snapshot: { status: 'waiting', running: false, open_requests: [{ id: 'srq-00000000000e', method: 'approval', params: { session_id: LIVE } }] } }])
    expect(s.items.filter(i => i.kind === 'clarify' || i.kind === 'approval')).toMatchObject([{ state: 'expired' }, { state: 'pending' }])
  })

  it('keeps the answers another client locked on a replayed clarify, also when the pending card is delivered again', () => {
    const questions = [{ qid: 'q0', question: 'Tea or coffee?' }, { qid: 'q1', question: 'Sugar?' }]
    const first = run(bound(), [req('srq-000000000021', 'clarify', { questions, answers: { q0: 'tea' } }, true)])
    expect(first.items.find(i => i.kind === 'clarify')).toMatchObject({ state: 'pending', locked: { q0: 'tea' } })

    const again = run(first, [req('srq-000000000021', 'clarify', { questions, answers: { q0: 'tea', q1: null } }, true)])
    expect(again.items.filter(i => i.kind === 'clarify')).toMatchObject([{ state: 'pending', locked: { q0: 'tea', q1: null } }])
  })

  it('takes no card for a method the phone does not show', () => {
    const s = run(bound(), [req('srq-00000000000f', 'setup_choose', { kind: 'question', question: 'Name?' }), req('srq-000000000010', 'display.install.sudo', {})])
    expect(s).toEqual(bound())
  })

  it('opens a prompt card per password prompt, with what each request says and nothing it left empty', () => {
    const s = run(bound(), [
      req('srq-000000000031', 'sudo', { command: '  apt install ripgrep ' }),
      req('srq-000000000032', 'secret', { env_var: 'GITHUB_TOKEN', prompt: 'For the GitHub skill', metadata: { skill: 'github' } }),
      req('srq-000000000033', 'vault.unlock_prompt', { backend: 'bitwarden', display_name: '' }),
      req('srq-000000000034', 'vault.save_login', { origin: 'https://github.com/login', site: 'GitHub' }),
      req('srq-000000000035', 'vault.code', { site: null, hint: 'From your authenticator app' })
    ])
    expect(s.items.filter(i => i.kind === 'prompt')).toEqual([
      { kind: 'prompt', id: 'prompt-srq-000000000031', requestId: 'srq-000000000031', method: 'sudo', fields: { command: 'apt install ripgrep' }, state: 'pending' },
      { kind: 'prompt', id: 'prompt-srq-000000000032', requestId: 'srq-000000000032', method: 'secret', fields: { envVar: 'GITHUB_TOKEN', prompt: 'For the GitHub skill' }, state: 'pending' },
      { kind: 'prompt', id: 'prompt-srq-000000000033', requestId: 'srq-000000000033', method: 'vault.unlock_prompt', fields: { manager: 'bitwarden' }, state: 'pending' },
      { kind: 'prompt', id: 'prompt-srq-000000000034', requestId: 'srq-000000000034', method: 'vault.save_login', fields: { origin: 'https://github.com/login', site: 'GitHub' }, state: 'pending' },
      { kind: 'prompt', id: 'prompt-srq-000000000035', requestId: 'srq-000000000035', method: 'vault.code', fields: { hint: 'From your authenticator app' }, state: 'pending' }
    ])
  })

  it('settles a prompt card as sent or declined, expires it on request.cancel, and keeps it pending after a failure', () => {
    const asked = run(bound(), [req('srq-000000000041', 'sudo', {}), req('srq-000000000042', 'secret', { env_var: 'X' }), req('srq-000000000043', 'vault.code', {})])
    const s = run(asked, [
      { type: 'prompt/failed', requestId: 'srq-000000000041', message: 'No connection to the gateway.' },
      { type: 'prompt/responded', requestId: 'srq-000000000042', declined: true },
      ev({ type: 'request.cancel', seq: 1, payload: { id: 'srq-000000000043', method: 'vault.code', reason: 'timeout' } })
    ])
    expect(s.items.filter(i => i.kind === 'prompt')).toMatchObject([
      { requestId: 'srq-000000000041', state: 'pending', error: 'No connection to the gateway.' },
      { requestId: 'srq-000000000042', state: 'declined' },
      { requestId: 'srq-000000000043', state: 'expired' }
    ])
    expect(pendingRequestIds(s)).toEqual(['srq-000000000041'])
    const sent = sessionReducer(s, { type: 'prompt/responded', requestId: 'srq-000000000041', declined: false })
    expect(sent.items.find(i => i.kind === 'prompt')).toMatchObject({ state: 'sent' })
    expect(sent.items.find(i => i.kind === 'prompt')).not.toHaveProperty('error', expect.anything())
  })

  it('keeps a pending prompt card through a history refetch, and drops a settled one', () => {
    const s = run(bound(), [req('srq-000000000051', 'sudo', {}), req('srq-000000000052', 'secret', {}), { type: 'prompt/responded', requestId: 'srq-000000000052', declined: false }])
    const refetched = sessionReducer(s, { type: 'history/loaded', messages: [] })
    expect(refetched.items.filter(i => i.kind === 'prompt')).toMatchObject([{ requestId: 'srq-000000000051', state: 'pending' }])
  })
})

describe('reconnect snapshot (session.activate)', () => {
  it('restores the partial answer from a running turn', () => {
    const s = run(bound(), [ev({ type: 'message.start', seq: 1 }), ev({ type: 'message.delta', seq: 2, payload: { text: 'half' } })])
    const activated = sessionReducer(s, { type: 'session/activated', result: activateResult({ running: true, status: 'streaming', inflight: { user: 'q', assistant: 'half an answer', streaming: true } }), at: 5, pendingWhenSent: [] })
    expect(activated.live).toMatchObject({ streaming: true, assistantText: 'half an answer' })
    expect(activated.replay.needsHistoryRefetch).toBe(false)
  })

  it('asks for history when the turn ended while the socket was down', () => {
    const s = run(bound(), [ev({ type: 'message.start', seq: 1 }), ev({ type: 'message.delta', seq: 2, payload: { text: 'half' } })])
    const activated = sessionReducer(s, { type: 'session/activated', result: activateResult(), at: 5, pendingWhenSent: [] })
    expect(activated.live).toMatchObject({ streaming: false, assistantText: '' })
    expect(activated.replay.needsHistoryRefetch).toBe(true)
  })

  it('leaves an idle session alone', () => {
    const activated = sessionReducer(bound(), { type: 'session/activated', result: activateResult(), at: 5, pendingWhenSent: [] })
    expect(activated.replay.needsHistoryRefetch).toBe(false)
    expect(activated.live.streaming).toBe(false)
  })
})

describe('busy sends', () => {
  it('marks a queued submit queued, then acknowledged when its turn starts', () => {
    const s = run(bound(), [
      { type: 'submit/started', localId: 'l1', text: 'and one more thing', at: 1 },
      { type: 'submit/queued', localId: 'l1' }
    ])
    expect(s.items[0]).toMatchObject({ kind: 'user', delivery: 'queued' })
    const started = sessionReducer(s, ev({ type: 'message.start', seq: 1 }))
    expect(started.items[0]).toMatchObject({ kind: 'user', delivery: 'acknowledged' })
  })

  it('keeps a send queued while the turn that starts is an earlier acknowledged one', () => {
    // An offline flush: both submits are answered before the first turn's first event.
    const s = run(bound(), [
      { type: 'submit/started', localId: 'l1', text: 'first', at: 1 },
      { type: 'submit/acknowledged', localId: 'l1' },
      { type: 'submit/started', localId: 'l2', text: 'second', at: 2 },
      { type: 'submit/queued', localId: 'l2' }
    ])
    expect(localTurnPending(s)).toBe(true)
    const started = sessionReducer(s, ev({ type: 'message.start', seq: 1 }))
    expect(started.items.filter(i => i.kind === 'user')).toMatchObject([{ localId: 'l1', delivery: 'acknowledged' }, { localId: 'l2', delivery: 'queued' }])

    const next = run(started, [ev({ type: 'message.complete', seq: 2, payload: { text: 'done', status: 'complete' } }), ev({ type: 'message.start', seq: 3 })])
    expect(next.items.filter(i => i.kind === 'user').at(-1)).toMatchObject({ localId: 'l2', delivery: 'acknowledged' })
  })

  it('reports no pending turn once every local send has ended', () => {
    const s = run(bound(), [
      { type: 'submit/started', localId: 'l1', text: 'first', at: 1 },
      { type: 'submit/acknowledged', localId: 'l1' },
      ev({ type: 'message.start', seq: 1 }),
      ev({ type: 'message.complete', seq: 2, payload: { text: 'done', status: 'complete' } })
    ])
    expect(localTurnPending(s)).toBe(false)
  })

  it('renders a redirected submit as a course correction, not a user turn', () => {
    const s = run(bound(), [
      { type: 'submit/started', localId: 'l1', text: 'no, use python', at: 1 },
      { type: 'submit/correction', localId: 'l1', status: 'redirected', at: 2 }
    ])
    expect(s.items.filter(i => i.kind === 'user')).toHaveLength(0)
    expect(s.items[0]).toMatchObject({ kind: 'event', text: 'Course correction: no, use python' })
  })

  it('restores unsent outbox items once each', () => {
    const restored: SessionAction = { type: 'outbox/restored', items: [{ localId: 'o1', text: 'sent while offline', at: 7, delivery: 'queued_unsent' }] }
    const s = run(bound(), [restored, restored])
    expect(s.items.filter(i => i.kind === 'user')).toHaveLength(1)
    expect(s.items[0]).toMatchObject({ kind: 'user', localId: 'o1', delivery: 'queued_unsent' })
  })
})

describe('routing and replay', () => {
  it('ignores events from other sessions and session-less non-global events', () => {
    const s = run(bound(), [
      { type: 'event', event: { type: 'message.start', session_id: 'other', seq: 1 } },
      { type: 'event', event: { type: 'sessions.changed', session_id: '', payload: {} } },
      { type: 'event', event: { type: 'message.delta', seq: 9, payload: { text: 'x' } } }
    ])
    expect(s.live.streaming).toBe(false)
    expect(s.replay.lastSeq).toBe(0)
  })

  it('drops events at or below the watermark', () => {
    const s = run(bound(), [ev({ type: 'message.start', seq: 5 }), ev({ type: 'message.delta', seq: 5, payload: { text: 'dup' } }), ev({ type: 'message.delta', seq: 4, payload: { text: 'old' } }), ev({ type: 'message.delta', seq: 6, payload: { text: 'new' } })])
    expect(s.live.assistantText).toBe('new')
    expect(s.replay.lastSeq).toBe(6)
  })

  it('folds a replay result and flags truncation', () => {
    const s = run(bound(), [ev({ type: 'message.start', seq: 1 })])
    const r = sessionReducer(s, { type: 'replay/result', result: { events: [{ type: 'message.delta', session_id: LIVE, seq: 2, payload: { text: 'hi' } }], latest_seq: 2, truncated: true, count: 1, epoch: 'epoch-fixture-1' } })
    expect(r.live.assistantText).toBe('hi')
    expect(r.replay).toMatchObject({ lastSeq: 2, needsHistoryRefetch: true })
  })

  it('resets the watermark on an epoch change', () => {
    const s = run(bound(), [ev({ type: 'message.start', seq: 40 })])
    const r = sessionReducer(s, { type: 'replay/result', result: { events: [], latest_seq: 0, truncated: false, count: 0, epoch: 'epoch-2' } })
    expect(r.replay).toEqual({ lastSeq: 0, epoch: 'epoch-2', needsHistoryRefetch: true })
    const ready = sessionReducer(r, { type: 'event', event: { type: 'gateway.ready', payload: { replay_epoch: 'epoch-3' } } })
    expect(ready.replay.epoch).toBe('epoch-3')
  })
})

describe('delivery states and history merge', () => {
  it('walks submitting -> unconfirmed -> submitting(retry) -> acknowledged', () => {
    const s = run(bound(), [
      { type: 'submit/started', localId: 'l1', text: 'hello', at: 1 },
      { type: 'submit/unconfirmed', localId: 'l1' },
    ])
    expect(s.items[0]).toMatchObject({ delivery: 'unconfirmed' })
    const retried = run(s, [{ type: 'submit/retry', localId: 'l1' }, { type: 'submit/acknowledged', localId: 'l1' }])
    expect(retried.items[0]).toMatchObject({ delivery: 'acknowledged' })
  })

  it('maps history rows to items, skipping hidden and empty rows', () => {
    const items = historyToItems(historyFixture.messages as HistoryMessage[])
    expect(items.map(i => i.kind)).toEqual(['user', 'assistant', 'user', 'tool', 'assistant'])
    expect(items[0]).toMatchObject({ rowId: 1, delivery: 'acknowledged' })
    const hidden = historyToItems([{ role: 'user', text: 'x', display_kind: 'hidden' }, { role: 'assistant', text: '' }])
    expect(hidden).toEqual([])
  })

  it('keeps an unconfirmed local message that history does not show, and drops one it does', () => {
    const s = run(bound(), [
      { type: 'history/loaded', messages: historyFixture.messages as HistoryMessage[] },
      { type: 'submit/started', localId: 'l1', text: 'Are you there?', at: 1 },
      { type: 'submit/unconfirmed', localId: 'l1' },
      { type: 'submit/started', localId: 'l2', text: 'Second', at: 2 },
      { type: 'submit/acknowledged', localId: 'l2' }
    ])
    const refreshed = sessionReducer(s, { type: 'history/loaded', messages: [...(historyFixture.messages as HistoryMessage[]), { role: 'user', text: 'Second', row_id: 5, timestamp: 3 }] })
    const users = refreshed.items.filter(i => i.kind === 'user')
    expect(users.map(u => (u.kind === 'user' ? u.text : ''))).toEqual(['Hi, can you hear me?', 'Summarize this photo.', 'Second', 'Are you there?'])
    expect(users.at(-1)).toMatchObject({ delivery: 'unconfirmed', localId: 'l1' })
    expect(users[2]).toMatchObject({ rowId: 5 })
  })

  it('mergeHistory marks an acknowledged local item unconfirmed when history lacks it', () => {
    const merged = mergeHistory([{ kind: 'user', id: 'a', localId: 'x', text: 'lost', delivery: 'acknowledged' }], [])
    expect(merged).toEqual([{ kind: 'user', id: 'a', localId: 'x', text: 'lost', delivery: 'unconfirmed' }])
  })

  it('keeps pending request cards across a history reload', () => {
    const s = run(bound(), [req('srq-000000000010', 'approval', { request_id: 'a1', command: 'ls' }), { type: 'history/loaded', messages: [] }])
    expect(s.items.filter(i => i.kind === 'approval')).toHaveLength(1)
  })
})

describe('agent traffic rows', () => {
  it('projects inbound bot rows, receipts and notices from the recorded histories', () => {
    const sender = historyToItems(historySender.messages as HistoryMessage[])
    expect(sender.some(i => i.kind === 'receipt' && i.receipt.headline.processId.startsWith('proc_'))).toBe(true)
    expect(sender.filter(i => i.kind === 'user').every(i => !i.text.startsWith('[IMPORTANT:'))).toBe(true)
    const receiver = historyToItems(historyReceiver.messages as HistoryMessage[])
    expect(receiver.find(i => i.kind === 'bot_message')).toMatchObject({ handle: 'hermes', provenance: 'inferred' })
  })

  it('keeps live message_agent tool items across a snapshot that omits them', () => {
    const live: ChatItem[] = [
      { kind: 'tool', id: 'tool-call_9', toolId: 'call_9', name: 'message_agent', done: true, result: { status: 'sent', process_id: 'proc_0123456789ab' } },
      { kind: 'tool', id: 'tool-call_8', toolId: 'call_8', name: 'terminal', done: true }
    ]
    const merged = mergeHistory(live, [{ kind: 'user', id: 'h-user-1', rowId: 1, text: 'hi', delivery: 'acknowledged' }])
    expect(merged.map(i => i.id)).toEqual(['h-user-1', 'tool-call_9'])
  })

  it('drops a live notice the snapshot now carries, and keeps one it does not', () => {
    const detail = '[IMPORTANT: Background process proc_0123456789ab is still running.]'
    const live: ChatItem[] = [{ kind: 'notice', id: 'notice-1', noticeKind: 'process', detail, live: true }]

    // A notice carries no id of its own, so the durable twin is recognised by its exact text.
    const reconciled = mergeHistory(live, [{ kind: 'notice', id: 'h-notice-7', rowId: 7, noticeKind: 'process', detail }])
    expect(reconciled.map(i => i.id)).toEqual(['h-notice-7'])

    const different = mergeHistory(live, [{ kind: 'notice', id: 'h-notice-7', rowId: 7, noticeKind: 'process', detail: `${detail} (edited)` }])
    expect(different.map(i => i.id)).toEqual(['h-notice-7', 'notice-1'])
  })

  it('projects a batch row into one receipt item per parsed receipt', () => {
    const items = historyToItems([{ role: 'user', text: receiptBatchThree.text, row_id: 201 }])
    const receipts = items.filter((i): i is Extract<ChatItem, { kind: 'receipt' }> => i.kind === 'receipt')
    expect(receipts).toHaveLength(3)
    expect(new Set(receipts.map(i => i.id)).size).toBe(3)
    expect(receipts.map(i => i.receipt.headline.processId)).toEqual(['proc_69dec248dc4e', 'proc_8a312511b81e', 'proc_10f6f4ec86f4'])
  })

  it('projects a receipt-shaped row that fails to parse as a notice, not a user bubble', () => {
    const items = historyToItems([{ role: 'user', text: receiptWatchMatch.text, row_id: 202 }])
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ kind: 'notice', noticeKind: 'process', detail: receiptWatchMatch.text })
    expect(items.filter(i => i.kind === 'user')).toHaveLength(0)
  })

  it('projects a v0.21.6 process_complete row into a receipt item, never a user bubble', () => {
    const items = historyToItems([{ role: 'user', text: receiptCliCut.text, row_id: 203, display_kind: 'process_complete', display_metadata: { display_text: TITLE } }])
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ kind: 'receipt', id: 'h-receipt-203-proc_c1d2e3f4a5b6', rowId: 203, displayKind: 'process_complete', receipt: { cut: 3072 } })
    expect(items.filter(i => i.kind === 'user')).toHaveLength(0)
  })

  it('projects a v0.21.6 failed_turn row into an assistant item that keeps its display kind', () => {
    // Hermes writes it as an assistant row (gateway/run_turn.py:1719-1721); Desktop draws it as a
    // system row (apps/desktop/src/lib/chat-messages/hydration.ts:163-171, :452).
    const items = historyToItems([{ role: 'assistant', text: FAILED_TURN_NOTICE, row_id: 204, display_kind: 'failed_turn' }])
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ kind: 'assistant', id: 'h-assistant-204', rowId: 204, text: FAILED_TURN_NOTICE, displayKind: 'failed_turn' })
    expect(items[0]).not.toHaveProperty('errorCard')
  })

  it('marks a failed_turn row whose error surface Desktop draws an error card from, as an object or as JSON text', () => {
    // agent/conversation_loop.py:1772-1788 stores it; hydration.ts:179-208 and error-surface.ts:100-122 read it.
    const surface = { error: 'HTTP 529: overloaded', error_surface: { layer: 'provider', code: 'overloaded', retryable: true } }
    const row = (displayMetadata: unknown): HistoryMessage => ({ role: 'assistant', text: FAILED_TURN_NOTICE, row_id: 205, display_kind: 'failed_turn', display_metadata: displayMetadata })
    expect(historyToItems([row(surface)])[0]).toMatchObject({ displayKind: 'failed_turn', errorCard: true })
    expect(historyToItems([row(JSON.stringify(surface))])[0]).toMatchObject({ errorCard: true })
    for (const noCard of [{ error: 'boom' }, { error_surface: { layer: 'weather', code: 'x' } }, { error_surface: 'provider' }, '{not json', null]) {
      expect(historyToItems([row(noCard)])[0]).not.toHaveProperty('errorCard')
    }
  })

  it('gives a receipt item a positional id, never "undefined", when the row has no row_id', () => {
    const items = historyToItems([{ role: 'user', text: liveJson.text }])
    const receipt = items.find(i => i.kind === 'receipt')
    expect(receipt?.id).toBe(`h-receipt-i0-${liveReceipt.headline.processId}`)
    expect(receipt?.id).not.toContain('undefined')
  })
})

describe('ownership, revisions, receipts', () => {
  it('collapses a duplicate message.start and keeps the buffers', () => {
    const s = run(bound(), [ev({ type: 'message.start', seq: 1 }), ev({ type: 'message.delta', seq: 2, payload: { text: 'po' } }), ev({ type: 'message.start', seq: 3 })])
    expect(s.live).toMatchObject({ streaming: true, assistantText: 'po', ownership: 'foreign' })
  })

  it('owns a turn locally only when a local send is in flight; foreign turns get no human transitions', () => {
    const local = run(bound(), [{ type: 'submit/started', localId: 'l1', text: 'x', at: 1 }, ev({ type: 'message.start', seq: 1 }), { type: 'submit/acknowledged', localId: 'l1' }])
    expect(local.live.ownership).toBe('local')
    const done = sessionReducer(local, ev({ type: 'message.complete', seq: 2, payload: { text: 'ok', status: 'complete' } }))
    expect((done.items[0] as { localId?: string }).localId).toBeUndefined()
    expect(done.tailWanted).toBe(1); expect(done.replay.needsHistoryRefetch).toBe(false)
    const foreign = run(bound(), [{ type: 'submit/started', localId: 'q1', text: 'later', at: 1 }, { type: 'submit/queued', localId: 'q1' }])
    // A queued local send IS local; a turn with nothing local in flight is foreign and refetches on completion.
    const f2 = run(bound(), [ev({ type: 'message.start', seq: 1 }), ev({ type: 'message.complete', seq: 2, payload: { text: 'from a routine' } })])
    expect(f2.replay.needsHistoryRefetch).toBe(true); expect(f2.tailWanted).toBe(0)
    const unknown = run(bound(), [{ type: 'turn/observed-running' }])
    expect(unknown.live.ownership).toBe('unknown')
    void foreign
  })

  it('discards a stale snapshot: the revision advanced while the fetch was in flight', () => {
    const s0 = bound()
    const captured = s0.revision
    const s1 = run(s0, [ev({ type: 'message.start', seq: 1 }), ev({ type: 'message.complete', seq: 2, payload: { text: 'new answer' } })])
    const stale = sessionReducer(s1, { type: 'history/loaded', messages: [], revision: captured })
    expect(stale.items.some(i => i.kind === 'assistant' && i.text === 'new answer')).toBe(true)
    // The fresh snapshot carries no new input row at all, so the live answer's anchor
    // cannot resolve unambiguously (spec 12.3): it is retained alongside the
    // durable row rather than folded onto it.
    const fresh = sessionReducer(s1, { type: 'history/loaded', messages: [{ role: 'assistant', text: 'new answer', row_id: 9 }], revision: s1.revision })
    expect(fresh.items).toHaveLength(2)
    expect(fresh.items.filter(i => i.kind === 'assistant' && i.text === 'new answer')).toHaveLength(2)
  })

  it('adds nothing for any process status.update, as Desktop, never touches the working line, and asks for the tail', () => {
    // Desktop only re-reads its process list for kind "process" (gateway-event/status.ts:116-119).
    for (const text of [SUBAGENT_TITLE, liveJson.text, receiptWatchMatch.text]) {
      const s = run(bound(), [ev({ type: 'status.update', seq: 1, payload: { kind: 'process', text } })])
      expect(s.items).toEqual([])
      expect(s.live.statusLine).toBeNull()
      expect(s.tailWanted).toBe(1)
    }
    const other = sessionReducer(bound(), ev({ type: 'status.update', seq: 3, payload: { kind: 'status', text: 'Thinking' } }))
    expect(other.live.statusLine).toBe('Thinking')
  })

  it('keeps the process id a receipt text names, for the anchor of the turn that runs on it (rules g and h)', () => {
    const s = run(bound(), [ev({ type: 'status.update', seq: 1, payload: { kind: 'process', text: liveJson.text } })])
    expect(s.pendingReceiptProcessId).toBe(liveReceipt.headline.processId)
    expect(run(bound(), [ev({ type: 'status.update', seq: 1, payload: { kind: 'process', text: SUBAGENT_TITLE } })]).pendingReceiptProcessId).toBeNull()
  })

  it('a subagent title never lingers after a refresh: its durable twin is the async_delegation_complete row', () => {
    const s = run(bound(), [ev({ type: 'status.update', seq: 1, payload: { kind: 'process', text: SUBAGENT_TITLE } })])
    const fresh: HistoryMessage[] = [
      { role: 'user', text: 'review the release notes in the background', row_id: 1 },
      { role: 'assistant', text: 'Started.', row_id: 2 },
      { role: 'user', text: '[ASYNC DELEGATION COMPLETE]', row_id: 3, display_kind: 'async_delegation_complete', display_metadata: { display_text: SUBAGENT_TITLE } }
    ]
    const merged = sessionReducer(s, { type: 'history/loaded', messages: fresh, revision: s.revision })
    expect(merged.items.map(i => i.kind)).toEqual(['user', 'assistant', 'event'])
  })

  it('adds nothing for the v0.21.6 process title and asks for the REST tail', () => {
    const s = run(bound(), [ev({ type: 'status.update', seq: 1, payload: { kind: 'process', text: TITLE } })])
    expect(s.items).toEqual([])
    expect(s.tailWanted).toBe(1)
    expect(s.live.statusLine).toBeNull()
    expect(s.pendingReceiptProcessId).toBeNull()
  })

  it('a message_agent tool.complete and a reconciled transcript row', () => {
    const s = run(bound(), [ev({ type: 'tool.start', seq: 1, payload: { tool_id: 'call_1', name: 'message_agent', args: { target: 'kevin', message: 'hi' } } }), ev({ type: 'tool.complete', seq: 2, payload: { tool_id: 'call_1', name: 'message_agent', result: { status: 'sent', process_id: 'proc_0123456789ab' } } })])
    expect(s.tailWanted).toBe(1); expect(s.revision).toBe(1)
    const r = sessionReducer(s, { type: 'transcript/reconciled', toolCallIds: ['call_1'] })
    expect(r.items.some(i => i.kind === 'tool')).toBe(false)
  })

  it('renders background.complete as a notice with the text in detail only', () => {
    const s = run(bound(), [ev({ type: 'background.complete', seq: 1, payload: { task_id: 't1', text: 'the side task said hello' } })])
    expect(s.items.at(-1)).toMatchObject({ kind: 'notice', noticeKind: 'process', detail: 'the side task said hello' })
  })
})

describe('the recorded send-and-reply turn (events-sender fixture)', () => {
  it('seals the local turn, keeps the process notification out of the working line, and refetches after the foreign one', () => {
    const frames = eventsSender as GatewayEventFrame[]
    let s = run(bound(), [{ type: 'submit/started', localId: 'l1', text: 'Ask Kevin when he can train.', at: 1 }, { type: 'submit/acknowledged', localId: 'l1' }])
    let afterLocalTurn: SessionState | null = null
    for (const frame of frames) {
      s = sessionReducer(s, { type: 'event', event: frame, at: 1_000 })
      // Spec 5.9: raw receipt text never reaches the working line.
      expect(s.live.statusLine ?? '').not.toContain('[IMPORTANT:')
      if (frame.type === 'message.complete' && !afterLocalTurn) {
        afterLocalTurn = s
      }
    }

    // The turn this device started is local: its user row is sealed, and nothing
    // has to be refetched to learn what happened.
    if (!afterLocalTurn) throw new Error('the fixture has no message.complete')
    expect(afterLocalTurn.items.filter(i => i.kind === 'user')).toHaveLength(1)
    expect((afterLocalTurn.items.find(i => i.kind === 'user') as { localId?: string }).localId).toBeUndefined()
    expect(afterLocalTurn.replay.needsHistoryRefetch).toBe(false)

    // The process notification adds no item, as on Desktop; the REST tail brings the receipt row.
    expect(s.items.some(i => i.kind === 'receipt' || i.kind === 'notice')).toBe(false)

    // The second turn was started by the delivery notification, not by this
    // device: only the durable transcript can say what it wrote.
    expect(s.replay.needsHistoryRefetch).toBe(true)
    // The local completion, the `message_agent` result and the process notification.
    expect(s.tailWanted).toBe(3)
    expect(s.items.filter(i => i.kind === 'assistant')).toHaveLength(2)
    // Rule (g): the notification turn still anchors on the receipt's process id.
    expect(s.items.at(-1)).toMatchObject({ kind: 'assistant', liveAnchor: { processId: 'proc_782bd84d7f2a' } })
    expect(s.live.streaming).toBe(false)
  })
})

describe('turn anchor and outcome (spec 12.3)', () => {
  const durable = (rowId: number, role: 'user' | 'assistant', text: string): HistoryMessage => ({ role, text, row_id: rowId, timestamp: rowId })
  const inbound = (rowId: number, text: string): HistoryMessage => durable(rowId, 'user', `Message from 🤖 hermes (@hermes): ${text}`)
  const toolRow = (rowId: number): HistoryMessage => ({ role: 'tool', name: 'terminal', row_id: rowId, timestamp: rowId } as HistoryMessage)

  it('records the newest known row id when a foreign turn starts and seals the answer with outcome and anchor', () => {
    const loaded = run(bound(), [{ type: 'history/loaded', messages: [inbound(11, 'hi'), durable(12, 'assistant', 'hello')] }])
    const started = sessionReducer(loaded, ev({ type: 'message.start', seq: 1 }))
    expect(started.turnAnchor).toEqual({ afterRowId: 12 })
    const done = run(started, [ev({ type: 'message.delta', seq: 2, payload: { text: 'sure' } }), ev({ type: 'message.complete', seq: 3, payload: { text: 'sure', status: 'ok' } })])
    expect(done.turnAnchor).toBeNull()
    expect(done.items.at(-1)).toMatchObject({ kind: 'assistant', text: 'sure', turnOutcome: 'completed', liveAnchor: { afterRowId: 12 } })
  })

  it('seals a failed turn as failed', () => {
    const s = run(bound(), [ev({ type: 'message.start', seq: 1 }), ev({ type: 'message.delta', seq: 2, payload: { text: 'x' } }), ev({ type: 'message.complete', seq: 3, payload: { status: 'error', error: 'boom' } })])
    expect(s.items.at(-1)).toMatchObject({ kind: 'assistant', turnOutcome: 'failed', error: 'boom' })
  })

  it('anchors a local turn on the user item it runs', () => {
    const s = run(bound(), [{ type: 'submit/started', localId: 'l1', text: 'Ping', at: 1 }, { type: 'submit/acknowledged', localId: 'l1' }, ev({ type: 'message.start', seq: 1 })])
    expect(s.turnAnchor).toEqual({ afterRowId: null, userItemId: 'local-l1' })
  })

  it('transfers the outcome to the durable answer on an unambiguous foreign match and drops the live item', () => {
    const loaded = run(bound(), [{ type: 'history/loaded', messages: [inbound(11, 'hi'), durable(12, 'assistant', 'hello')] }])
    const done = run(loaded, [ev({ type: 'message.start', seq: 1 }), ev({ type: 'message.delta', seq: 2, payload: { text: 'sure' } }), ev({ type: 'message.complete', seq: 3, payload: { text: 'sure', status: 'ok' } })])
    const fresh = [inbound(11, 'hi'), durable(12, 'assistant', 'hello'), inbound(13, 'again?'), durable(14, 'assistant', 'sure')]
    const merged = sessionReducer(done, { type: 'history/loaded', messages: fresh, revision: done.revision })
    expect(merged.items.map(i => i.id)).toEqual(['h-bot-11', 'h-assistant-12', 'h-bot-13', 'h-assistant-14'])
    expect(merged.items[3]).toMatchObject({ kind: 'assistant', rowId: 14, turnOutcome: 'completed' })
  })

  it('keeps the live item and its outcome when the match is ambiguous (two new input rows)', () => {
    const loaded = run(bound(), [{ type: 'history/loaded', messages: [inbound(11, 'hi'), durable(12, 'assistant', 'hello')] }])
    const done = run(loaded, [ev({ type: 'message.start', seq: 1 }), ev({ type: 'message.delta', seq: 2, payload: { text: 'sure' } }), ev({ type: 'message.complete', seq: 3, payload: { text: 'sure', status: 'ok' } })])
    const fresh = [inbound(11, 'hi'), durable(12, 'assistant', 'hello'), inbound(13, 'again?'), durable(14, 'assistant', 'sure'), inbound(15, 'and?'), durable(16, 'assistant', 'yes')]
    const merged = sessionReducer(done, { type: 'history/loaded', messages: fresh, revision: done.revision })
    expect(merged.items.at(-1)).toMatchObject({ kind: 'assistant', text: 'sure', turnOutcome: 'completed', liveAnchor: { afterRowId: 12 } })
    expect((merged.items.at(-1) as { rowId?: number }).rowId).toBeUndefined()
    expect(merged.items.filter(i => i.kind === 'assistant' && i.rowId !== undefined).every(i => i.kind === 'assistant' && i.turnOutcome === undefined)).toBe(true)
  })

  it('keeps the live item when the durable turn holds two answers after its last tool row', () => {
    const loaded = run(bound(), [{ type: 'history/loaded', messages: [inbound(11, 'hi'), durable(12, 'assistant', 'hello')] }])
    const done = run(loaded, [ev({ type: 'message.start', seq: 1 }), ev({ type: 'message.delta', seq: 2, payload: { text: 'sure' } }), ev({ type: 'message.complete', seq: 3, payload: { text: 'sure', status: 'ok' } })])
    // A real tool row, so the two answers really do follow the turn's LAST tool row.
    const fresh = [inbound(11, 'hi'), durable(12, 'assistant', 'hello'), inbound(13, 'again?'), toolRow(14), durable(15, 'assistant', 'first'), durable(16, 'assistant', 'sure')]
    const merged = sessionReducer(done, { type: 'history/loaded', messages: fresh, revision: done.revision })
    expect(merged.items.some(i => i.kind === 'tool')).toBe(true)
    expect(merged.items.at(-1)).toMatchObject({ kind: 'assistant', text: 'sure', turnOutcome: 'completed' })
    expect(merged.items.find(i => i.kind === 'assistant' && i.rowId === 16)).not.toHaveProperty('turnOutcome')
  })

  it('anchors a local turn through the outbox item reconciled to a unique durable row', () => {
    const sent = run(bound(), [
      { type: 'history/loaded', messages: [durable(1, 'user', 'old'), durable(2, 'assistant', 'old answer')] },
      { type: 'submit/started', localId: 'l1', text: 'Ping', at: 1 },
      { type: 'submit/acknowledged', localId: 'l1' },
      ev({ type: 'message.start', seq: 1 }),
      ev({ type: 'message.delta', seq: 2, payload: { text: 'Pong' } }),
      ev({ type: 'message.complete', seq: 3, payload: { text: 'Pong', status: 'ok' } })
    ])
    expect(sent.items.at(-1)).toMatchObject({ kind: 'assistant', turnOutcome: 'completed', liveAnchor: { afterRowId: 2, userItemId: 'local-l1' } })
    const fresh = [durable(1, 'user', 'old'), durable(2, 'assistant', 'old answer'), durable(3, 'user', 'Ping'), durable(4, 'assistant', 'Pong')]
    const merged = sessionReducer(sent, { type: 'history/loaded', messages: fresh, revision: sent.revision })
    expect(merged.items.map(i => i.id)).toEqual(['h-user-1', 'h-assistant-2', 'h-user-3', 'h-assistant-4'])
    expect(merged.items[3]).toMatchObject({ turnOutcome: 'completed' })
  })

  it('a turn found already running anchors on the input row history already holds', () => {
    // `turn/observed-running` starts a turn whose input row is already
    // durable, so the refetch after its completion brings no NEW input row at all.
    const loaded = run(bound(), [{ type: 'history/loaded', messages: [inbound(11, 'hi'), durable(12, 'assistant', 'hello'), inbound(13, 'again?')] }])
    const observed = sessionReducer(loaded, { type: 'turn/observed-running', at: 900 })
    expect(observed.turnAnchor).toEqual({ afterRowId: 13, observedInputRowId: 13 })
    const done = run(observed, [ev({ type: 'message.delta', seq: 2, payload: { text: 'sure' } }), ev({ type: 'message.complete', seq: 3, payload: { text: 'sure', status: 'ok' } })])
    expect(done.items.at(-1)).toMatchObject({ kind: 'assistant', turnOutcome: 'completed', liveAnchor: { afterRowId: 13, observedInputRowId: 13 } })
    const fresh = [inbound(11, 'hi'), durable(12, 'assistant', 'hello'), inbound(13, 'again?'), durable(14, 'assistant', 'sure')]
    const merged = sessionReducer(done, { type: 'history/loaded', messages: fresh, revision: done.revision })
    expect(merged.items.map(i => i.id)).toEqual(['h-bot-11', 'h-assistant-12', 'h-bot-13', 'h-assistant-14'])
    expect(merged.items[3]).toMatchObject({ kind: 'assistant', rowId: 14, turnOutcome: 'completed' })
  })

  it('drops a completed retained answer at the second reconciliation that cannot place it, and keeps a failed one', () => {
    // A completed answer whose durable twin is already in the transcript
    // is dropped rather than drawn forever; failed and unknown are never dropped.
    const start = (status: string) => {
      const loaded = run(bound(), [{ type: 'history/loaded', messages: [inbound(11, 'hi'), durable(12, 'assistant', 'hello')] }])
      return run(loaded, [ev({ type: 'message.start', seq: 1 }), ev({ type: 'message.delta', seq: 2, payload: { text: 'sure' } }), ev({ type: 'message.complete', seq: 3, payload: { text: 'sure', status } })])
    }
    const ambiguous = [inbound(11, 'hi'), durable(12, 'assistant', 'hello'), inbound(13, 'again?'), durable(14, 'assistant', 'sure'), inbound(15, 'and?'), durable(16, 'assistant', 'yes')]
    const moreAmbiguous = [...ambiguous, inbound(17, 'more?'), durable(18, 'assistant', 'ok')]

    const completed = start('ok')
    const once = sessionReducer(completed, { type: 'history/loaded', messages: ambiguous, revision: completed.revision })
    expect(once.items.at(-1)).toMatchObject({ kind: 'assistant', text: 'sure', turnOutcome: 'completed', liveAnchor: { afterRowId: 12, retainedBeforeRowId: 16, retainedRounds: 1 } })
    const twice = sessionReducer(once, { type: 'history/loaded', messages: moreAmbiguous, revision: once.revision })
    expect(twice.items.some(i => i.kind === 'assistant' && i.rowId === undefined)).toBe(false)

    const failed = start('error')
    const failedOnce = sessionReducer(failed, { type: 'history/loaded', messages: ambiguous, revision: failed.revision })
    const failedTwice = sessionReducer(failedOnce, { type: 'history/loaded', messages: moreAmbiguous, revision: failedOnce.revision })
    expect(failedTwice.items.at(-1)).toMatchObject({ kind: 'assistant', text: 'sure', turnOutcome: 'failed', liveAnchor: { retainedRounds: 2 } })
  })

  it('excludes a candidate turn already explained by a recorded outcome, anchoring on the other one (rule d)', () => {
    // Real race: two chained foreign turns complete before the first refetch lands. The first live
    // answer is already transferred onto row 14 by an earlier reconciliation; a second live answer,
    // sealed with `afterRowId` still at the pre-refetch value, then sees BOTH new input rows (13 and
    // 15) as candidates. Row 13's turn is already explained (its unique answer, row 14, already
    // carries a turnOutcome), so only row 15's turn remains and the second answer anchors there.
    const loaded = run(bound(), [{ type: 'history/loaded', messages: [inbound(11, 'hi'), durable(12, 'assistant', 'hello')] }])
    const firstDone = run(loaded, [ev({ type: 'message.start', seq: 1 }), ev({ type: 'message.delta', seq: 2, payload: { text: 'sure' } }), ev({ type: 'message.complete', seq: 3, payload: { text: 'sure', status: 'ok' } })])
    const afterFirstRefetch = [inbound(11, 'hi'), durable(12, 'assistant', 'hello'), inbound(13, 'again?'), durable(14, 'assistant', 'sure')]
    const merged = sessionReducer(firstDone, { type: 'history/loaded', messages: afterFirstRefetch, revision: firstDone.revision })
    expect(merged.items.find(i => i.kind === 'assistant' && i.rowId === 14)).toMatchObject({ turnOutcome: 'completed' })

    // The second live answer: constructed directly (driving it through events would race the
    // first refetch in a way this synchronous test cannot reproduce), sealed with `afterRowId: 12`
    // — the value the first live turn also started from, since this second turn began before the
    // first refetch's rows 13/14 ever landed.
    const withSecondLive: SessionState = {
      ...merged,
      items: [...merged.items, { kind: 'assistant', id: 'live-2', text: 'yes', turnOutcome: 'completed', liveAnchor: { afterRowId: 12 } }]
    }
    const secondRefetch = [...afterFirstRefetch, inbound(15, 'and?'), durable(16, 'assistant', 'yes')]
    const final = sessionReducer(withSecondLive, { type: 'history/loaded', messages: secondRefetch, revision: withSecondLive.revision })
    expect(final.items.find(i => i.kind === 'assistant' && i.rowId === 16)).toMatchObject({ turnOutcome: 'completed' })
    expect(final.items.some(i => i.kind === 'assistant' && i.rowId === undefined)).toBe(false)
  })

  it('still retains when two new input rows both lack a recorded outcome (unchanged behavior)', () => {
    const loaded = run(bound(), [{ type: 'history/loaded', messages: [inbound(11, 'hi'), durable(12, 'assistant', 'hello')] }])
    const done = run(loaded, [ev({ type: 'message.start', seq: 1 }), ev({ type: 'message.delta', seq: 2, payload: { text: 'sure' } }), ev({ type: 'message.complete', seq: 3, payload: { text: 'sure', status: 'ok' } })])
    const fresh = [inbound(11, 'hi'), durable(12, 'assistant', 'hello'), inbound(13, 'again?'), durable(14, 'assistant', 'sure'), inbound(15, 'and?'), durable(16, 'assistant', 'yes')]
    const merged = sessionReducer(done, { type: 'history/loaded', messages: fresh, revision: done.revision })
    expect(merged.items.at(-1)).toMatchObject({ kind: 'assistant', text: 'sure', turnOutcome: 'completed', liveAnchor: { afterRowId: 12 } })
    expect((merged.items.at(-1) as { rowId?: number }).rowId).toBeUndefined()
  })

  it('an outcome survives a later reconciliation that carries the same row', () => {
    const loaded = run(bound(), [{ type: 'history/loaded', messages: [inbound(11, 'hi'), durable(12, 'assistant', 'hello')] }])
    const done = run(loaded, [ev({ type: 'message.start', seq: 1 }), ev({ type: 'message.delta', seq: 2, payload: { text: 'sure' } }), ev({ type: 'message.complete', seq: 3, payload: { text: 'sure', status: 'ok' } })])
    const fresh = [inbound(11, 'hi'), durable(12, 'assistant', 'hello'), inbound(13, 'again?'), durable(14, 'assistant', 'sure')]
    const once = sessionReducer(done, { type: 'history/loaded', messages: fresh, revision: done.revision })
    const twice = sessionReducer(once, { type: 'history/loaded', messages: [...fresh, inbound(15, 'more'), durable(16, 'assistant', 'ok')], revision: once.revision })
    expect(twice.items.find(i => i.kind === 'assistant' && i.rowId === 14)).toMatchObject({ turnOutcome: 'completed' })
    expect(twice.items.find(i => i.kind === 'assistant' && i.rowId === 16)).not.toHaveProperty('turnOutcome')
  })

  it('rule (e): the simulator case — a receipt row with no answer yet cannot be the home of the sealed answer', () => {
    // Real case on the simulator (Kevin's chat): durable rows 61 inbound bot message, 62 its
    // answer, 63 receipt row. Hermes persists the receipt row before its own turn answers, so
    // the first refetch after the live answer seals sees two new input rows (61, 63) while 63's
    // turn has no answer row at all yet. Rule (e) excludes 63 from the candidate set, so only 61
    // remains and the live answer transfers onto 62 instead of being retained as a duplicate.
    const loaded = run(bound(), [{ type: 'history/loaded', messages: [durable(59, 'user', 'hi'), durable(60, 'assistant', 'hello')] }])
    const done = run(loaded, [ev({ type: 'message.start', seq: 1 }), ev({ type: 'message.delta', seq: 2, payload: { text: 'sure' } }), ev({ type: 'message.complete', seq: 3, payload: { text: 'sure', status: 'ok' } })])
    expect(done.turnAnchor).toBeNull()
    const fresh = [
      durable(59, 'user', 'hi'), durable(60, 'assistant', 'hello'),
      inbound(61, 'kevin says hi'), durable(62, 'assistant', 'sure'),
      durable(63, 'user', liveJson.text)
    ]
    const merged = sessionReducer(done, { type: 'history/loaded', messages: fresh, revision: done.revision })
    expect(merged.items.find(i => i.kind === 'assistant' && i.rowId === 62)).toMatchObject({ turnOutcome: 'completed' })
    expect(merged.items.some(i => i.kind === 'assistant' && i.rowId === undefined)).toBe(false)

    // A second foreign turn (the receipt turn's own reply) then completes; its live answer is
    // anchored before row 63 became visible (`afterRowId: 62`), and the next refetch delivers
    // the receipt turn's answer at row 64. It should transfer there, leaving no live item behind.
    const withSecondLive: SessionState = {
      ...merged,
      items: [...merged.items, { kind: 'assistant', id: 'live-2', text: 'yes', turnOutcome: 'completed', liveAnchor: { afterRowId: 62 } }]
    }
    const secondFresh = [...fresh, durable(64, 'assistant', 'yes')]
    const final = sessionReducer(withSecondLive, { type: 'history/loaded', messages: secondFresh, revision: withSecondLive.revision })
    expect(final.items.find(i => i.kind === 'assistant' && i.rowId === 64)).toMatchObject({ turnOutcome: 'completed' })
    expect(final.items.some(i => i.kind === 'assistant' && i.rowId === undefined)).toBe(false)
  })

  it('rule (f): a fixed point within one call lets an earlier retained item benefit from a later item\'s transfer', () => {
    // Two live items in the same reconciliation: A (afterRowId 12) is ambiguous between the
    // turns at rows 13 and 15 until B (afterRowId 14, unambiguous onto row 16) transfers first
    // and explains row 15's turn (rule d). Processing A and B once in order would leave A
    // retained; the fixed-point re-run picks it up in a second pass once row 16 is explained.
    const base = bound()
    const withLive: SessionState = {
      ...base,
      items: [
        { kind: 'assistant', id: 'live-a', text: 'sure', turnOutcome: 'completed', liveAnchor: { afterRowId: 12 } },
        { kind: 'assistant', id: 'live-b', text: 'yes', turnOutcome: 'completed', liveAnchor: { afterRowId: 14 } }
      ]
    }
    const fresh = [inbound(11, 'hi'), durable(12, 'assistant', 'hello'), inbound(13, 'again?'), durable(14, 'assistant', 'sure'), inbound(15, 'and?'), durable(16, 'assistant', 'yes')]
    const merged = sessionReducer(withLive, { type: 'history/loaded', messages: fresh, revision: withLive.revision })
    expect(merged.items.find(i => i.kind === 'assistant' && i.rowId === 14)).toMatchObject({ turnOutcome: 'completed' })
    expect(merged.items.find(i => i.kind === 'assistant' && i.rowId === 16)).toMatchObject({ turnOutcome: 'completed' })
    expect(merged.items.some(i => i.kind === 'assistant' && i.rowId === undefined)).toBe(false)
  })

  it('rule (g): the receipt-anchored simulator sequence places both live answers, driven through events', () => {
    // Kevin's chat on the simulator. Durable rows: 61 inbound bot message, 62 its answer, 63 the
    // receipt row for process P, 64 the receipt-driven turn's answer. Live order: turn A seals
    // (L1), the process notification names P while nothing is running, turn B
    // starts and seals (L2). B's anchor records P, so L2 resolves to row 63 (hard-id pairing,
    // spec 5.2/5.5) and transfers onto 64; L1 then anchors on 61 by exclusion (rule d).
    const processId = liveReceipt.headline.processId
    const loaded = run(bound(), [{ type: 'history/loaded', messages: [durable(59, 'user', 'hi'), durable(60, 'assistant', 'hello')] }])
    const afterA = run(loaded, [
      ev({ type: 'message.start', seq: 1 }),
      ev({ type: 'message.delta', seq: 2, payload: { text: 'sure' } }),
      ev({ type: 'message.complete', seq: 3, payload: { text: 'sure', status: 'ok' } })
    ])
    const afterReceipt = sessionReducer(afterA, ev({ type: 'status.update', seq: 4, payload: { kind: 'process', text: liveJson.text } }))
    expect(afterReceipt.pendingReceiptProcessId).toBe(processId)
    const startedB = run(afterReceipt, [ev({ type: 'message.start', seq: 5 }), ev({ type: 'message.start', seq: 6 })])
    expect(startedB.turnAnchor).toMatchObject({ afterRowId: 60, processId })
    expect(startedB.pendingReceiptProcessId).toBeNull()
    const afterB = run(startedB, [
      ev({ type: 'message.delta', seq: 7, payload: { text: 'yes' } }),
      ev({ type: 'message.complete', seq: 8, payload: { text: 'yes', status: 'ok' } })
    ])
    expect(afterB.items.at(-1)).toMatchObject({ kind: 'assistant', text: 'yes', turnOutcome: 'completed', liveAnchor: { afterRowId: 60, processId } })

    const fresh = [
      durable(59, 'user', 'hi'), durable(60, 'assistant', 'hello'),
      inbound(61, 'kevin says hi'), durable(62, 'assistant', 'sure'),
      durable(63, 'user', liveJson.text), durable(64, 'assistant', 'yes')
    ]
    const merged = sessionReducer(afterB, { type: 'history/loaded', messages: fresh, revision: afterB.revision })
    expect(merged.items.find(i => i.kind === 'assistant' && i.rowId === 62)).toMatchObject({ turnOutcome: 'completed' })
    expect(merged.items.find(i => i.kind === 'assistant' && i.rowId === 64)).toMatchObject({ turnOutcome: 'completed' })
    expect(merged.items.some(i => i.kind === 'assistant' && i.rowId === undefined)).toBe(false)
    expect(merged.pendingReceiptProcessId).toBeNull()
  })

  it('rule (h): a receipt observed while a turn is streaming does not anchor that turn, but anchors the next one', () => {
    // Real case on the simulator: Hermes's reply triggers an inbound bot-message turn A that
    // starts streaming, and the receipt for Kevin's own earlier send arrives WHILE A streams.
    // A cannot own it (it already started); the receipt-driven turn B starts right after A
    // completes and must anchor on it.
    const processId = liveReceipt.headline.processId
    const loaded = run(bound(), [{ type: 'history/loaded', messages: [durable(59, 'user', 'hi'), durable(60, 'assistant', 'hello')] }])
    const streaming = run(loaded, [ev({ type: 'message.start', seq: 1 }), ev({ type: 'status.update', seq: 2, payload: { kind: 'process', text: liveJson.text } })])
    // Turn A itself never gets the id — the receipt cannot belong to the turn already running.
    expect(streaming.turnAnchor?.processId).toBeUndefined()
    expect(streaming.pendingReceiptProcessId).toBe(processId)
    const afterA = run(streaming, [ev({ type: 'message.delta', seq: 3, payload: { text: 'sure' } }), ev({ type: 'message.complete', seq: 4, payload: { text: 'sure', status: 'ok' } })])
    // Rule (h): message.complete no longer clears it — it survives the completion of the turn
    // it interrupted.
    expect(afterA.pendingReceiptProcessId).toBe(processId)
    const startedB = run(afterA, [ev({ type: 'message.start', seq: 5 }), ev({ type: 'message.start', seq: 6 })])
    expect(startedB.turnAnchor).toMatchObject({ processId })
    expect(startedB.pendingReceiptProcessId).toBeNull()
    const afterB = run(startedB, [ev({ type: 'message.delta', seq: 7, payload: { text: 'yes' } }), ev({ type: 'message.complete', seq: 8, payload: { text: 'yes', status: 'ok' } })])
    expect(afterB.items.at(-1)).toMatchObject({ kind: 'assistant', text: 'yes', turnOutcome: 'completed', liveAnchor: { processId } })

    // Both live answers transfer once history/loaded carries [inbound 61, answer 62, receipt 63,
    // answer 64]: none is retained.
    const fresh = [
      durable(59, 'user', 'hi'), durable(60, 'assistant', 'hello'),
      inbound(61, 'kevin says hi'), durable(62, 'assistant', 'sure'),
      durable(63, 'user', liveJson.text), durable(64, 'assistant', 'yes')
    ]
    const merged = sessionReducer(afterB, { type: 'history/loaded', messages: fresh, revision: afterB.revision })
    expect(merged.items.find(i => i.kind === 'assistant' && i.rowId === 62)).toMatchObject({ turnOutcome: 'completed' })
    expect(merged.items.find(i => i.kind === 'assistant' && i.rowId === 64)).toMatchObject({ turnOutcome: 'completed' })
    expect(merged.items.some(i => i.kind === 'assistant' && i.rowId === undefined)).toBe(false)
  })

  it('rule (h): session/activated clears a pending receipt id (running branch)', () => {
    const loaded = run(bound(), [{ type: 'history/loaded', messages: [durable(59, 'user', 'hi'), durable(60, 'assistant', 'hello')] }])
    const withPending = sessionReducer(loaded, ev({ type: 'status.update', seq: 1, payload: { kind: 'process', text: liveJson.text } }))
    expect(withPending.pendingReceiptProcessId).not.toBeNull()
    const activated: SessionAction = {
      type: 'session/activated',
      result: { session_id: LIVE, session_key: STORED, status: 'streaming', running: true, message_count: 0, messages: [], messages_omitted: true, info: {} },
      at: 10,
      pendingWhenSent: []
    }
    const result = sessionReducer(withPending, activated)
    expect(result.pendingReceiptProcessId).toBeNull()
  })

  it('rule (h): session/activated clears a pending receipt id (idle branch)', () => {
    const loaded = run(bound(), [{ type: 'history/loaded', messages: [durable(59, 'user', 'hi'), durable(60, 'assistant', 'hello')] }])
    const withPending = sessionReducer(loaded, ev({ type: 'status.update', seq: 1, payload: { kind: 'process', text: liveJson.text } }))
    expect(withPending.pendingReceiptProcessId).not.toBeNull()
    const activated: SessionAction = {
      type: 'session/activated',
      result: { session_id: LIVE, session_key: STORED, status: 'idle', running: false, message_count: 0, messages: [], messages_omitted: true, info: {} },
      at: 10,
      pendingWhenSent: []
    }
    const result = sessionReducer(withPending, activated)
    expect(result.pendingReceiptProcessId).toBeNull()
  })

  it('rule (h): session/resumed clears a pending receipt id', () => {
    const loaded = run(bound(), [{ type: 'history/loaded', messages: [durable(59, 'user', 'hi'), durable(60, 'assistant', 'hello')] }])
    const withPending = sessionReducer(loaded, ev({ type: 'status.update', seq: 1, payload: { kind: 'process', text: liveJson.text } }))
    expect(withPending.pendingReceiptProcessId).not.toBeNull()
    const resumed: SessionAction = { type: 'session/resumed', snapshot: { status: 'idle', running: false, inflight: null } }
    const result = sessionReducer(withPending, resumed)
    expect(result.pendingReceiptProcessId).toBeNull()
  })

  it('rule (h): a local turn start discards a pending receipt id without anchoring on it', () => {
    const loaded = run(bound(), [{ type: 'history/loaded', messages: [durable(59, 'user', 'hi'), durable(60, 'assistant', 'hello')] }])
    const withPending = sessionReducer(loaded, ev({ type: 'status.update', seq: 1, payload: { kind: 'process', text: liveJson.text } }))
    expect(withPending.pendingReceiptProcessId).not.toBeNull()
    const started = run(withPending, [
      { type: 'submit/started', localId: 'l1', text: 'Ping', at: 1 },
      { type: 'submit/acknowledged', localId: 'l1' },
      ev({ type: 'message.start', seq: 2 })
    ])
    expect(started.turnAnchor).toEqual({ afterRowId: 60, userItemId: 'local-l1' })
    expect(started.pendingReceiptProcessId).toBeNull()
  })

  it('rule (g): with no durable receipt row yet, the existing rules still decide (rule e, unchanged)', () => {
    // Same shape as the rule (e) case, but the live turn carries a process id whose receipt row
    // has not arrived: the process-id rule falls through and rule (e) excludes row 63's answerless
    // turn, so the live answer still transfers onto row 62.
    const loaded = run(bound(), [{ type: 'history/loaded', messages: [durable(59, 'user', 'hi'), durable(60, 'assistant', 'hello')] }])
    const done = run(loaded, [ev({ type: 'message.start', seq: 1 }), ev({ type: 'message.delta', seq: 2, payload: { text: 'sure' } }), ev({ type: 'message.complete', seq: 3, payload: { text: 'sure', status: 'ok' } })])
    const withProcess: SessionState = {
      ...done,
      items: done.items.map(i =>
        i.kind === 'assistant' && i.rowId === undefined && i.liveAnchor
          ? { ...i, liveAnchor: { ...i.liveAnchor, processId: 'proc_ffffffffffff' } }
          : i
      )
    }
    const fresh = [
      durable(59, 'user', 'hi'), durable(60, 'assistant', 'hello'),
      inbound(61, 'kevin says hi'), durable(62, 'assistant', 'sure'),
      durable(63, 'user', liveJson.text)
    ]
    const merged = sessionReducer(withProcess, { type: 'history/loaded', messages: fresh, revision: withProcess.revision })
    expect(merged.items.find(i => i.kind === 'assistant' && i.rowId === 62)).toMatchObject({ turnOutcome: 'completed' })
    expect(merged.items.some(i => i.kind === 'assistant' && i.rowId === undefined)).toBe(false)
  })

  it('rules (d) and (g) on v0.21.6 rows: the failed_turn row takes the failed outcome, the notification turn after it its own', () => {
    // Durable rows: 61 an inbound row whose turn failed, 62 the failed_turn row Hermes closed it with
    // (agent/conversation_loop.py:1848-1850), 63 the process_complete row for P
    // (tui_gateway/session_notifications.py:598-602), 64 the answer of the turn that ran on it. The
    // timeline draws 61 to 64 as one turn, as Desktop does; reconciliation still pairs by Hermes's turns.
    const processId = liveReceipt.headline.processId
    const loaded = run(bound(), [{ type: 'history/loaded', messages: [durable(59, 'user', 'hi'), durable(60, 'assistant', 'hello')] }])
    const afterB = run(loaded, [
      ev({ type: 'message.start', seq: 1 }),
      ev({ type: 'message.delta', seq: 2, payload: { text: 'checking' } }),
      ev({ type: 'message.complete', seq: 3, payload: { status: 'error', error: 'boom' } }),
      ev({ type: 'status.update', seq: 4, payload: { kind: 'process', text: liveJson.text } }),
      ev({ type: 'message.start', seq: 5 }),
      ev({ type: 'message.delta', seq: 6, payload: { text: 'yes' } }),
      ev({ type: 'message.complete', seq: 7, payload: { text: 'yes', status: 'ok' } })
    ])
    expect(afterB.items.at(-1)).toMatchObject({ kind: 'assistant', text: 'yes', liveAnchor: { afterRowId: 60, processId } })

    const fresh: HistoryMessage[] = [
      durable(59, 'user', 'hi'), durable(60, 'assistant', 'hello'),
      inbound(61, 'is the build green?'),
      { role: 'assistant', text: FAILED_TURN_NOTICE, row_id: 62, timestamp: 62, display_kind: 'failed_turn' },
      { role: 'user', text: liveJson.text, row_id: 63, timestamp: 63, display_kind: 'process_complete' },
      durable(64, 'assistant', 'yes')
    ]
    const merged = sessionReducer(afterB, { type: 'history/loaded', messages: fresh, revision: afterB.revision })
    expect(merged.items.find(i => i.kind === 'assistant' && i.rowId === 62)).toMatchObject({ turnOutcome: 'failed', displayKind: 'failed_turn' })
    expect(merged.items.find(i => i.kind === 'assistant' && i.rowId === 64)).toMatchObject({ turnOutcome: 'completed' })
    expect(merged.items.some(i => i.kind === 'assistant' && i.rowId === undefined)).toBe(false)
  })

  it('rule (e) boundary: a candidate turn with two answers (not zero) still leaves the live item retained', () => {
    const loaded = run(bound(), [{ type: 'history/loaded', messages: [inbound(11, 'hi'), durable(12, 'assistant', 'hello')] }])
    const done = run(loaded, [ev({ type: 'message.start', seq: 1 }), ev({ type: 'message.delta', seq: 2, payload: { text: 'sure' } }), ev({ type: 'message.complete', seq: 3, payload: { text: 'sure', status: 'ok' } })])
    const fresh = [inbound(11, 'hi'), durable(12, 'assistant', 'hello'), inbound(13, 'again?'), toolRow(14), durable(15, 'assistant', 'first'), durable(16, 'assistant', 'sure')]
    const merged = sessionReducer(done, { type: 'history/loaded', messages: fresh, revision: done.revision })
    expect(merged.items.at(-1)).toMatchObject({ kind: 'assistant', text: 'sure', turnOutcome: 'completed' })
    expect((merged.items.at(-1) as { rowId?: number }).rowId).toBeUndefined()
  })
})

describe('idle snapshot (spec 12.3)', () => {
  const resumed = (over: Partial<import('./session-reducer').ResumeSnapshot> = {}): SessionAction => ({ type: 'session/resumed', snapshot: { status: 'idle', running: false, inflight: null, ...over } })
  const activate = (over: Partial<ActivateResult> = {}): SessionAction => ({ type: 'session/activated', result: { session_id: LIVE, session_key: STORED, status: 'idle', running: false, message_count: 0, messages: [], messages_omitted: true, info: {}, ...over }, at: 5, pendingWhenSent: [] })

  it('is confirmed by an idle resume payload and not by resuming, waiting, starting or a running turn', () => {
    expect(sessionReducer(bound(), resumed()).idleSnapshot).toEqual({ confirmed: true, hydrating: false, autoContinue: false })
    expect(sessionReducer(bound(), resumed({ status: 'resuming' })).idleSnapshot.confirmed).toBe(false)
    expect(sessionReducer(bound(), resumed({ status: 'waiting' })).idleSnapshot.confirmed).toBe(false)
    expect(sessionReducer(bound(), resumed({ status: 'starting' })).idleSnapshot.confirmed).toBe(false)
    expect(sessionReducer(bound(), resumed({ running: true, status: 'streaming' })).idleSnapshot.confirmed).toBe(false)
    expect(sessionReducer(bound(), resumed({ inflight: { user: 'q', assistant: '', streaming: false, error: 'x' } })).idleSnapshot.confirmed).toBe(false)
  })

  it('a resume with hydrating: true followed by an activate payload without the field still blocks the snapshot', () => {
    const hydrating = sessionReducer(bound(), resumed({ status: 'resuming', hydrating: true }))
    expect(hydrating.idleSnapshot).toEqual({ confirmed: false, hydrating: true, autoContinue: false })
    const activated = sessionReducer(hydrating, activate())
    expect(activated.idleSnapshot.confirmed).toBe(false)
    // a later resume payload without the field clears it
    expect(sessionReducer(activated, resumed()).idleSnapshot).toEqual({ confirmed: true, hydrating: false, autoContinue: false })
    // and so does the hydration-complete progress event
    const progressed = sessionReducer(hydrating, ev({ type: 'session.resume_progress', payload: { phase: 'history', status: 'complete' } }))
    expect(progressed.idleSnapshot.hydrating).toBe(false)
    expect(sessionReducer(progressed, activate()).idleSnapshot.confirmed).toBe(true)
  })

  it('a scheduled auto-continuation blocks the snapshot until its turn completes', () => {
    const pending = sessionReducer(bound(), resumed({ auto_continue: { attempt: 1 } }))
    expect(pending.idleSnapshot).toEqual({ confirmed: false, hydrating: false, autoContinue: true })
    expect(sessionReducer(pending, activate()).idleSnapshot.confirmed).toBe(false)
    const ran = run(pending, [ev({ type: 'message.start', seq: 1 }), ev({ type: 'message.complete', seq: 2, payload: { text: 'done', status: 'ok' } })])
    expect(ran.idleSnapshot.autoContinue).toBe(false)
    expect(sessionReducer(ran, activate()).idleSnapshot.confirmed).toBe(true)
  })

  it('any newer live event invalidates the snapshot until the next payload', () => {
    const idle = sessionReducer(bound(), resumed())
    expect(sessionReducer(idle, ev({ type: 'message.start', seq: 1 })).idleSnapshot.confirmed).toBe(false)
    expect(sessionReducer(idle, ev({ type: 'status.update', seq: 1, payload: { kind: 'process', text: liveJson.text } })).idleSnapshot.confirmed).toBe(false)
    expect(sessionReducer(idle, ev({ type: 'status.update', seq: 1, payload: { text: 'thinking' } })).idleSnapshot.confirmed).toBe(false)
    expect(sessionReducer(idle, { type: 'turn/observed-running' }).idleSnapshot.confirmed).toBe(false)
    expect(sessionReducer(idle, req('srq-000000000011', 'approval', APPROVAL)).idleSnapshot.confirmed).toBe(false)
    const invalidated = sessionReducer(idle, ev({ type: 'message.start', seq: 1 }))
    expect(sessionReducer(invalidated, activate()).idleSnapshot.confirmed).toBe(true)
  })

  it('a turn that ends without message.complete seals its text as an unknown outcome', () => {
    const streaming = run(bound(), [ev({ type: 'message.start', seq: 1 }), ev({ type: 'message.delta', seq: 2, payload: { text: 'half' } })])
    const dropped = sessionReducer(streaming, activate())
    expect(dropped.items.at(-1)).toMatchObject({ kind: 'assistant', text: 'half', turnOutcome: 'unknown' })
    expect(dropped.replay.needsHistoryRefetch).toBe(true)
    const errored = sessionReducer(streaming, ev({ type: 'error', seq: 3, payload: { message: 'boom' } }))
    expect(errored.items.at(-1)).toMatchObject({ kind: 'assistant', text: 'half', turnOutcome: 'unknown' })
    // no text streamed: nothing to seal
    const silent = sessionReducer(sessionReducer(bound(), ev({ type: 'message.start', seq: 1 })), activate())
    expect(silent.items).toHaveLength(0)
  })

  it('an error while streaming seals the reasoning once and empties the live buffers', () => {
    const streaming = run(bound(), [
      ev({ type: 'message.start', seq: 1 }),
      ev({ type: 'reasoning.delta', seq: 2, payload: { text: 'thinking hard' } }),
      ev({ type: 'message.delta', seq: 3, payload: { text: 'half' } })
    ])
    const errored = sessionReducer(streaming, ev({ type: 'error', seq: 4, payload: { message: 'boom' } }))
    // One home for the reasoning: leaving it on `live` too listed it twice in Activity.
    const assistants = errored.items.filter(i => i.kind === 'assistant')
    expect(assistants).toHaveLength(1)
    expect(assistants[0]).toMatchObject({ turnOutcome: 'unknown', text: 'half', reasoning: 'thinking hard' })
    expect(errored.live).toMatchObject({ streaming: false, assistantText: '', reasoningText: '' })
    expect(errored.turnAnchor).toBeNull()
  })

  it('an error before any text leaves no turn anchor behind', () => {
    const started = sessionReducer(bound(), ev({ type: 'message.start', seq: 1 }))
    expect(started.turnAnchor).not.toBeNull()
    const errored = sessionReducer(started, ev({ type: 'error', seq: 2, payload: { message: 'boom' } }))
    expect(errored.items).toHaveLength(0)
    expect(errored.turnAnchor).toBeNull()
  })
})
