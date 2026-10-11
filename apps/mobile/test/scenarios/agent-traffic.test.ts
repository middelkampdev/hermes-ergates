/**
 * Scenarios for bot-to-bot traffic: the REST transcript window the chat screen
 * drives (spec 5.5/5.8), live evidence that survives a snapshot which omits it,
 * and the stale-snapshot reschedule.
 *
 * The session is the real `createSessionController`; the transcript window runs
 * the same pure `window.ts` rules as `use-transcript.ts` (ADR-029 rule 3).
 */
import { describe, expect, it } from 'vitest'

import { buildExchanges, collectEvidence, exchangeCopy } from '@/features/chat/agent-traffic/exchange'
import type { RosterPeer } from '@/features/chat/agent-traffic/types'
import { FIRST_PAGE_LIMIT, TAIL_LIMIT } from '@/features/chat/agent-traffic/window'
import { createSessionController } from '@/features/chat/session-controller'
import type { GatewayEventFrame, HistoryMessage, TranscriptQuery, TranscriptRawPage } from '@/gateway/types'

import { flush } from '@test/fake-gateway/fake-websocket'
import historyFixture from '@test/fixtures/history.json'
import receiptCliCut from '@test/fixtures/agent-traffic/receipt-cli-cut.json'
import liveJson from '@test/fixtures/agent-traffic/receipt-live-json.json'
import transcriptSender from '@test/fixtures/agent-traffic/transcript-sender.json'

import { FakeGateway, type FakeScript } from '../fake-gateway/fake-gateway'
import { memoryOutbox } from '../fake-gateway/memory-outbox'
import { transcriptWindow } from '../fake-gateway/transcript-window'

const roster: RosterPeer[] = [
  { profile: 'default', name: 'Hermes', hasAvatar: true },
  { profile: 'kevin', name: 'Kevin', hasAvatar: true }
]

/** A refused send: the tool completes with an error the 5.3 reason table calls `refused`. */
const ZED_ARGS = { target: 'zed', message: 'hi' }
const REFUSED_TURN: GatewayEventFrame[] = [
  { type: 'message.start', seq: 1 },
  { type: 'tool.start', seq: 2, payload: { tool_id: 'call_r', name: 'message_agent', args: ZED_ARGS } },
  { type: 'tool.complete', seq: 3, payload: { tool_id: 'call_r', name: 'message_agent', args: ZED_ARGS, result: { error: 'no such', reason: 'target_busy' } } },
  { type: 'message.complete', seq: 4, payload: { text: 'Could not reach zed.', status: 'complete' } }
]

describe('a refused send with no process', () => {
  it('asks for a tail, reconciles it with the REST page, and reads as unreachable', async () => {
    const gateway = new FakeGateway({ onSubmit: () => REFUSED_TURN })
    const controller = createSessionController({ port: gateway, profile: 'thijs', connectionId: 'c-test', outbox: memoryOutbox() })
    await controller.open()
    const transcript = transcriptWindow(gateway, controller, 'thijs')

    await controller.send('Send a short hello to zed')
    await flush(20)

    // Two triggers: the `message_agent` completion and the local turn's completion (spec 5.8).
    expect(controller.getView().state.tailWanted).toBe(2)

    await transcript.fetchInitial()
    await transcript.fetchTail()

    // The first tail page overlaps the loaded window, so the run stops after one page.
    expect(gateway.calls.transcript.count).toBe(2)
    expect(gateway.calls.transcript.lastQuery).toMatchObject({ limit: TAIL_LIMIT, offset: 0, order: 'latest' })

    const loaded = transcript.current()
    expect(loaded.loaded).toBe(true)
    const build = buildExchanges(collectEvidence(controller.getView().state.items, loaded.rows), { roster, window: loaded })
    const refused = build.exchanges.find(x => x.anchor.toolCallId === 'call_r')
    expect(refused).toBeDefined()
    expect(refused?.phase).toBe('settled')
    expect(exchangeCopy(refused!)).toBe('zed could not be reached')
    // Nothing older is missing: the window reached the start of the recorded chat.
    expect(build.needsOlder).toBe(false)
  })
})

/** What v0.21.6 sends in `status.update {kind: "process"}` for a completion (session_notifications.py:546-552). */
const TITLE = 'Background Process Finished: /opt/data/hermes/hermes-agent/venv/bin/python /opt/data/hermes/hermes-agent/tools/bot_mo...'

/** A send to Kevin whose long reply Hermes cut (receipt-cli-cut.json), as v0.21.6 streams it. */
const KEVIN_ARGS = { target: 'kevin', message: 'When can you train?' }
const V0216_TURN: GatewayEventFrame[] = [
  { type: 'message.start', seq: 1 },
  { type: 'tool.start', seq: 2, payload: { tool_id: 'call_k', name: 'message_agent', args: KEVIN_ARGS } },
  { type: 'tool.complete', seq: 3, payload: { tool_id: 'call_k', name: 'message_agent', args: KEVIN_ARGS, result: receiptCliCut.result } },
  { type: 'message.complete', seq: 4, payload: { text: 'I asked Kevin.', status: 'complete' } },
  { type: 'status.update', seq: 5, payload: { kind: 'process', text: TITLE } }
]

/** The recorded sender rows plus the three durable rows of that send; the last one is the v0.21.6 receipt row. */
const V0216_ROWS: unknown[] = [
  ...(transcriptSender.messages as unknown[]),
  { id: 127, role: 'assistant', content: '', timestamp: 1789376000, tool_calls: [{ id: 'call_k', type: 'function', function: { name: 'message_agent', arguments: JSON.stringify(KEVIN_ARGS) } }] },
  { id: 128, role: 'tool', content: JSON.stringify(receiptCliCut.result), timestamp: 1789376001, tool_call_id: 'call_k', tool_name: 'message_agent' },
  { id: 129, role: 'user', content: receiptCliCut.text, timestamp: 1789376060, display_kind: 'process_complete', display_metadata: { display_text: TITLE } }
]

/** `rows` paged like the REST route: counted from the newest end for `order: 'latest'`, returned ascending. */
function pageOf(rows: unknown[], q: TranscriptQuery & { sessionId: string }): TranscriptRawPage {
  const fromNewest = [...rows].reverse().slice(q.offset ?? 0, (q.offset ?? 0) + q.limit)
  const messages = q.order === 'latest' ? fromNewest.reverse() : rows.slice(q.offset ?? 0, (q.offset ?? 0) + q.limit)
  return { session_id: q.sessionId, messages, pagination: { limit: q.limit, offset: q.offset ?? 0, order: q.order, returned: messages.length } }
}

describe('a v0.21.6 delivery', () => {
  it('folds from the process_complete row the REST tail brings; the live title adds no item', async () => {
    const gateway = new FakeGateway({ onSubmit: () => V0216_TURN, transcript: q => pageOf(V0216_ROWS, q) })
    const controller = createSessionController({ port: gateway, profile: 'thijs', connectionId: 'c-test', outbox: memoryOutbox() })
    await controller.open()
    const transcript = transcriptWindow(gateway, controller, 'thijs')

    await controller.send('Ask Kevin when he can train')
    await flush(20)

    // The `message_agent` completion, the local turn's completion and the process title (spec 5.8).
    expect(controller.getView().state.tailWanted).toBe(3)

    await transcript.fetchInitial()
    await transcript.fetchTail()

    expect(controller.getView().state.items.filter(i => i.kind === 'notice')).toEqual([])
    const build = buildExchanges(collectEvidence(controller.getView().state.items, transcript.current().rows), { roster, window: transcript.current() })
    const kevin = build.exchanges.find(x => x.anchor.toolCallId === 'call_k')
    expect(kevin).toMatchObject({ phase: 'settled', state: { delivery: 'settled', reply: { kind: 'excerpt' } } })
    expect(exchangeCopy(kevin!)).toBe('2 messages with Kevin · shortened by Hermes')
    expect(build.unpaired).toEqual([])
  })
})

describe('a live receipt across a snapshot that omits it', () => {
  it('survives the refetch and goes only when the transcript reconciles it', async () => {
    const processId = 'proc_b2c3d4e5f6a7'
    // An EMPTY snapshot, not the recorded one: the strongest form of "history does
    // not carry it yet".
    const gateway = new FakeGateway({ history: () => [] })
    const controller = createSessionController({ port: gateway, profile: 'thijs', connectionId: 'c-test', outbox: memoryOutbox() })
    await controller.open()
    const live = controller.getView().state.liveSessionId ?? ''

    gateway.connectionFor('thijs').emit({ type: 'status.update', session_id: live, seq: 30, payload: { kind: 'process', text: liveJson.text } })
    const receipts = controller.getView().state.items.filter(i => i.kind === 'receipt')
    expect(receipts).toHaveLength(1)
    expect(receipts[0]).toMatchObject({ live: true })
    // The notification itself is a tail trigger, even for a receipt we already hold.
    expect(controller.getView().state.tailWanted).toBe(1)

    // Absence from a snapshot is not evidence of absence: the live receipt is all
    // that is left after an empty one.
    await controller.refetchHistory()
    expect(controller.getView().state.items.map(i => i.kind)).toEqual(['receipt'])

    controller.dispatchReconciled({ toolCallIds: [], processIds: [processId] })
    expect(controller.getView().state.items.filter(i => i.kind === 'receipt')).toHaveLength(0)
  })
})

describe('a snapshot that went stale in flight (spec 5.8)', () => {
  it('discards it and fetches again instead of rolling the newer turn back', async () => {
    let release = (): void => {}
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    const newer: HistoryMessage[] = [
      ...(historyFixture.messages as HistoryMessage[]),
      { role: 'assistant', text: 'Kevin is free on Tuesday.', row_id: 9001, timestamp: 1789203999 }
    ]
    const gateway = new FakeGateway({ history: call => (call === 1 ? gate.then(() => undefined) : newer) })
    const controller = createSessionController({ port: gateway, profile: 'thijs', connectionId: 'c-test', outbox: memoryOutbox() })
    await controller.open()
    const connection = gateway.connectionFor('thijs')
    const live = controller.getView().state.liveSessionId ?? ''

    const pending = controller.refetchHistory()
    await flush(1)

    // A turn we did not start completes while the snapshot is in flight: the
    // snapshot predates it and would remove it.
    connection.emit({ type: 'message.start', session_id: live, seq: 40 })
    connection.emit({ type: 'message.complete', session_id: live, seq: 41, payload: { text: 'Kevin is free on Tuesday.', status: 'complete' } })
    release()
    await pending
    await flush(20)

    // Three reads: the held snapshot (discarded as stale), the refetch the
    // foreign turn's completion asked the controller for, and the re-read of
    // the discarded snapshot.
    expect(gateway.calls.history).toBe(3)
    expect(controller.getView().state.replay.needsHistoryRefetch).toBe(false)
    // The held snapshot predates the answer and was not allowed to roll it back.
    // The first accepted snapshot kept the live answer next to its durable row
    // (an ambiguous match, spec 12.3); the second one confirms the same
    // row, so only the durable answer is left.
    const arrived = controller.getView().state.items.filter(i => i.kind === 'assistant' && i.text === 'Kevin is free on Tuesday.')
    expect(arrived).toHaveLength(1)
    expect(arrived[0]).toMatchObject({ rowId: 9001 })
  })
})

describe('a tail that has not reached the loaded boundary', () => {
  it('continues one page backward and stops on the first overlapping page', async () => {
    const queries: TranscriptQuery[] = []
    const rows = (from: number, count: number): unknown[] =>
      Array.from({ length: count }, (_, i) => ({ id: from + i, role: 'assistant', content: `row ${from + i}`, timestamp: 1789203900 + from + i }))
    const answer = (sessionId: string, q: TranscriptQuery, messages: unknown[]): TranscriptRawPage => ({
      session_id: sessionId,
      messages,
      pagination: { limit: q.limit, offset: q.offset ?? 0, order: q.order, returned: messages.length }
    })
    const script: FakeScript = {
      transcript: q => {
        queries.push(q)
        // The loaded window: rows 1-60. Since then 50 newer rows (101-150) were written.
        if (q.limit === FIRST_PAGE_LIMIT) return answer(q.sessionId, q, rows(1, 60))
        return (q.offset ?? 0) === 0 ? answer(q.sessionId, q, rows(101, 50)) : answer(q.sessionId, q, rows(51, 50))
      }
    }
    const gateway = new FakeGateway(script)
    const controller = createSessionController({ port: gateway, profile: 'thijs', connectionId: 'c-test', outbox: memoryOutbox() })
    await controller.open()
    const transcript = transcriptWindow(gateway, controller, 'thijs')

    await transcript.fetchInitial()
    await transcript.fetchTail()

    expect(queries.map(q => [q.limit, q.offset])).toEqual([
      [FIRST_PAGE_LIMIT, 0],
      [TAIL_LIMIT, 0],
      [TAIL_LIMIT, TAIL_LIMIT]
    ])
    const loaded = transcript.current()
    // 1-60 and 101-150, joined by 51-100: the ten rows the second page repeats merge away.
    expect(loaded.rows).toHaveLength(150)
    expect(loaded.newestLoadedRowId).toBe(150)
    expect(loaded.oldestLoadedRowId).toBe(1)
  })
})
