import { describe, expect, it } from 'vitest'

import type { ChatItem } from '../history'

import {
  buildExchanges,
  collectEvidence,
  deriveState,
  exchangeCopy,
  exchangeIdentities,
  isOpenable,
  memberStates,
  mergeConsecutive,
  type Evidence,
  type Exchange,
  type WindowBounds,
} from './exchange'
import { parseReceiptRow, type ParsedReceipt } from './receipt'
import { normalizeTranscriptPage } from './transcript'
import type { ExchangeState, PeerRef, RosterPeer, TranscriptRow } from './types'

import senderPageRaw from '@test/fixtures/agent-traffic/transcript-sender.json'
import senderPage1Raw from '@test/fixtures/agent-traffic/transcript-sender-page1.json'
import receiptCli from '@test/fixtures/agent-traffic/receipt-cli.json'
import receiptCliCut from '@test/fixtures/agent-traffic/receipt-cli-cut.json'
import receiptRefusalJson from '@test/fixtures/agent-traffic/receipt-refusal-json.json'
import receiptDamaged from '@test/fixtures/agent-traffic/receipt-damaged.json'
import receiptBatchTwo from '@test/fixtures/agent-traffic/receipt-batch-two.json'

// ---------------------------------------------------------------------------
// Shared fixtures and helpers
// ---------------------------------------------------------------------------

const roster: RosterPeer[] = [
  { profile: 'default', name: 'Hermes', hasAvatar: true },
  { profile: 'kevin', name: 'Kevin', hasAvatar: true },
]

const REACHED_START: WindowBounds = { loaded: true, oldestLoadedRowId: 1, reachedStart: true }
const MID_WINDOW: WindowBounds = { loaded: true, oldestLoadedRowId: 99, reachedStart: false }

const senderRows = normalizeTranscriptPage(senderPageRaw as never).rows
const page1Rows = normalizeTranscriptPage(senderPage1Raw as never).rows

/** The recorded CLI exchange: send rows 94/95, receipt row 99. */
const CLI_CALL_ID = 'call_W7BH7HW4zAEwvNbj4kNYzWUh'
const CLI_PROCESS_ID = 'proc_782bd84d7f2a'
/** The recorded refusal for a nonexistent teammate: send rows 110/111, no process. */
const REFUSAL_CALL_ID = 'call_pJm7ALPH5a9L1p3dfWebcHV4'

const kevinPeer: PeerRef = { handle: 'kevin', profile: 'kevin', display: { name: 'Kevin', avatarProfile: 'kevin' } }

interface ReceiptFixture { text: string; result: Record<string, unknown> | null }

function parsed(text: string): ParsedReceipt {
  const parse = parseReceiptRow(text)
  if (parse.kind !== 'receipts' || !parse.receipts[0]) throw new Error(`not a receipt row: ${text.slice(0, 60)}`)
  return parse.receipts[0]
}

/** Builds a receipt row text with the given headline description, exit code and body. */
function receiptText(processId: string, description: string, exitCode: string, body: string): string {
  return `[IMPORTANT: Background process ${processId} ${description} (exit code ${exitCode}).\nCommand: run-delivery\nOutput:\n${body}]`
}

function sendEvidence(over: Partial<Evidence['sends'][number]> = {}): Evidence['sends'][number] {
  return { toolCallId: 'call_1', target: 'kevin', message: 'Hi', done: true, ...over }
}

function evidenceOf(over: Partial<Evidence> = {}): Evidence {
  return { sends: [], results: [], receipts: [], ...over }
}

function build(evidence: Evidence, window: WindowBounds = REACHED_START) {
  return buildExchanges(evidence, { roster, window })
}

function exchangeById(list: Exchange[], toolCallId: string): Exchange {
  const found = list.find(x => x.anchor.toolCallId === toolCallId)
  if (!found) throw new Error(`no exchange for ${toolCallId}`)
  return found
}

// ---------------------------------------------------------------------------
// collectEvidence (spec 5.5: ids only, never text/target/position)
// ---------------------------------------------------------------------------

describe('collectEvidence', () => {
  it('collects every recorded message_agent send, its result and its receipt', () => {
    const evidence = collectEvidence([], senderRows)

    expect(evidence.sends.map(s => s.toolCallId)).toEqual([
      'call_Nfx9qJkrcOBUSpNkVll8VCEm',
      CLI_CALL_ID,
      'call_B0fvHiZUchl0fdsEWOqZbJfA',
      REFUSAL_CALL_ID,
      'call_nRwha9TQ0oE9AugWq67WcB4K',
      'call_QZXUy0W80yGtyEPZwlzOFkxc',
    ])
    expect(evidence.sends.every(s => s.done && s.anchorRowId !== undefined && s.message.length > 0)).toBe(true)
    expect(evidence.sends.find(s => s.toolCallId === CLI_CALL_ID)).toMatchObject({ anchorRowId: 94, target: 'kevin' })
    expect(evidence.sends.find(s => s.toolCallId === REFUSAL_CALL_ID)?.target).toBe('zed')

    // every send has a result by tool call id
    for (const send of evidence.sends) {
      expect(evidence.results.some(r => r.toolCallId === send.toolCallId)).toBe(true)
    }

    // every result that names a process has a receipt by process id
    const processIds = evidence.results.map(r => (r.result as { process_id?: string }).process_id).filter((p): p is string => typeof p === 'string')
    expect(processIds).toHaveLength(5)
    for (const processId of processIds) {
      expect(evidence.receipts.some(r => r.processId === processId)).toBe(true)
    }
    expect(evidence.receipts.map(r => r.rowId)).toEqual([91, 99, 107, 121, 125])
    expect(evidence.receipts.find(r => r.processId === CLI_PROCESS_ID)).toMatchObject({ rowId: 99, itemId: `h-receipt-99-${CLI_PROCESS_ID}` })
  })

  it('collects live sends, live results and receipts from chat items', () => {
    const receipt = parsed(receiptText('proc_0123456789ab', 'completed normally', '0', 'Sure thing.'))
    const items: ChatItem[] = [
      { kind: 'tool', id: 'tool-call_live', toolId: 'call_live', name: 'message_agent', args: { target: 'kevin', message: 'Hi' }, result: { status: 'sent', process_id: 'proc_0123456789ab' }, done: true },
      { kind: 'tool', id: 'tool-call_other', toolId: 'call_other', name: 'terminal', args: { command: 'ls' }, result: { output: '' }, done: true },
      { kind: 'receipt', id: 'h-receipt-i2-proc_0123456789ab', receipt },
    ]
    const evidence = collectEvidence(items, [])

    expect(evidence.sends).toEqual([{ toolCallId: 'call_live', target: 'kevin', message: 'Hi', liveItemId: 'tool-call_live', done: true }])
    expect(evidence.results).toEqual([{ toolCallId: 'call_live', result: { status: 'sent', process_id: 'proc_0123456789ab' }, liveItemId: 'tool-call_live' }])
    expect(evidence.receipts).toEqual([{ processId: 'proc_0123456789ab', receipt, itemId: 'h-receipt-i2-proc_0123456789ab', itemIds: ['h-receipt-i2-proc_0123456789ab'] }])
  })

  it('keeps a live tool item that is still running as a not-done send with no result', () => {
    const items: ChatItem[] = [{ kind: 'tool', id: 'tool-call_live', toolId: 'call_live', name: 'message_agent', args: { target: 'kevin', message: 'Hi' }, done: false }]
    const evidence = collectEvidence(items, [])
    expect(evidence.sends[0]?.done).toBe(false)
    expect(evidence.results).toEqual([])
  })

  it('dedupes by tool call id and process id: REST wins, the item ids are kept for folding', () => {
    const receipt = parsed(receiptText(CLI_PROCESS_ID, 'completed normally', '0', 'Reply text'))
    const items: ChatItem[] = [
      { kind: 'tool', id: `tool-${CLI_CALL_ID}`, toolId: CLI_CALL_ID, name: 'message_agent', args: { target: 'kevin', message: 'Hi' }, result: { status: 'sent' }, done: true },
      { kind: 'receipt', id: `h-receipt-i1-${CLI_PROCESS_ID}`, receipt },
    ]
    const evidence = collectEvidence(items, senderRows)

    expect(evidence.sends.filter(s => s.toolCallId === CLI_CALL_ID)).toHaveLength(1)
    expect(evidence.sends.find(s => s.toolCallId === CLI_CALL_ID)).toMatchObject({ anchorRowId: 94, liveItemId: `tool-${CLI_CALL_ID}` })
    expect(evidence.results.filter(r => r.toolCallId === CLI_CALL_ID)).toHaveLength(1)
    expect(evidence.results.find(r => r.toolCallId === CLI_CALL_ID)?.rowId).toBe(95)
    expect(evidence.receipts.filter(r => r.processId === CLI_PROCESS_ID)).toHaveLength(1)
    expect(evidence.receipts.find(r => r.processId === CLI_PROCESS_ID)?.rowId).toBe(99)
  })

  it('keeps every item id of one process when the same receipt arrives twice', () => {
    const receipt = parsed(receiptText(CLI_PROCESS_ID, 'completed normally', '0', 'Reply text'))
    // a socket-history receipt on a row without a row_id: its item id cannot be rebuilt from the process id
    const items: ChatItem[] = [{ kind: 'receipt', id: `h-receipt-i7-${CLI_PROCESS_ID}`, receipt }]
    const evidence = collectEvidence(items, senderRows)

    const merged = evidence.receipts.filter(r => r.processId === CLI_PROCESS_ID)
    expect(merged).toHaveLength(1)
    expect(merged[0]?.rowId).toBe(99)
    expect(merged[0]?.itemIds).toEqual([`h-receipt-99-${CLI_PROCESS_ID}`, `h-receipt-i7-${CLI_PROCESS_ID}`])

    const cli = exchangeById(build(evidence).exchanges, CLI_CALL_ID)
    expect(cli.members).toContain(`h-receipt-99-${CLI_PROCESS_ID}`)
    expect(cli.members).toContain(`h-receipt-i7-${CLI_PROCESS_ID}`)
  })

  it('never reads a stamped bot message as a receipt, however its text reads', () => {
    // A peer can send text that looks exactly like a receipt; the `a2a_message` stamp settles it first
    // (spec 5.1 evidence order), the same way `window.ts` classifies the row.
    const text = receiptText('proc_dddddddddddd', 'completed normally', '0', 'Sure thing.')
    const rows: TranscriptRow[] = [{ id: 8, role: 'user', text, content: text, displayKind: 'a2a_message', displayMetadata: { sender_handle: 'kevin', sender_id: 'bot_1' } }]
    expect(collectEvidence([], rows).receipts).toEqual([])

    // the same text without the stamp is still a receipt
    const bare: TranscriptRow[] = [{ id: 8, role: 'user', text, content: text }]
    expect(collectEvidence([], bare).receipts.map(r => r.processId)).toEqual(['proc_dddddddddddd'])
  })

  it('reads a receipt row out of the REST page even when a batch row carries several', () => {
    const one = receiptText('proc_aaaaaaaaaaaa', 'completed normally', '0', 'first')
    const two = receiptText('proc_bbbbbbbbbbbb', 'completed normally', '0', 'second')
    const batch = `[IMPORTANT: 2 background processes completed. Treat these results as one batch.]\n\n${one}\n\n${two}`
    const rows: TranscriptRow[] = [{ id: 7, role: 'user', text: batch, content: batch }]
    const evidence = collectEvidence([], rows)
    expect(evidence.receipts.map(r => r.processId)).toEqual(['proc_aaaaaaaaaaaa', 'proc_bbbbbbbbbbbb'])
    expect(evidence.receipts.map(r => r.itemId)).toEqual(['h-receipt-7-proc_aaaaaaaaaaaa', 'h-receipt-7-proc_bbbbbbbbbbbb'])
  })
})

// ---------------------------------------------------------------------------
// deriveState (spec 4.3, 5.3)
// ---------------------------------------------------------------------------

describe('deriveState', () => {
  it('maps a persisted send with no result and no receipt to unknown / not observed', () => {
    expect(deriveState({ sendDone: true })).toEqual({
      state: { delivery: 'unknown', worker: { kind: 'not_observed' }, reply: { kind: 'none' }, latestOutcomeUnavailable: false },
      evidence: { provenance: 'structured' },
      notice: false,
    })
  })

  it('takes delivery from the result status and marks the worker running while no receipt exists', () => {
    const derived = deriveState({ result: { status: 'sent', to: '@kevin', process_id: 'proc_0123456789ab' }, sendDone: true })
    expect(derived.state).toEqual({ delivery: 'admitted', worker: { kind: 'running' }, reply: { kind: 'none' }, latestOutcomeUnavailable: false })
    expect(derived.evidence).toMatchObject({ status: 'sent', processId: 'proc_0123456789ab' })
  })

  it('does not call a worker running while the send itself is still in flight', () => {
    expect(deriveState({ result: { status: 'sent', process_id: 'proc_0123456789ab' }, sendDone: false }).state.worker).toEqual({ kind: 'not_observed' })
  })

  it('takes delivery from an error result without a status through the reason table', () => {
    const derived = deriveState({ result: { error: "No teammate named 'zed'", reason: 'target_busy' }, sendDone: true })
    expect(derived.state.delivery).toBe('refused')
    expect(derived.evidence).toMatchObject({ reason: 'target_busy', error: "No teammate named 'zed'" })
    expect(deriveState({ result: { error: 'nope', reason: 'unknown' }, sendDone: true }).state.delivery).toBe('unknown')
  })

  it('lets the receipt outcome override the result delivery and carry the reply', () => {
    const receipt = parsed(receiptText('proc_0123456789ab', 'completed normally', '0', 'Tuesday at 18:00 works.'))
    const derived = deriveState({ result: { status: 'sent', process_id: 'proc_0123456789ab' }, receipt, sendDone: true })
    expect(derived.state).toEqual({
      delivery: 'settled',
      worker: { kind: 'exited', code: 0 },
      reply: { kind: 'text', body: 'Tuesday at 18:00 works.', completeness: 'unknown' },
      latestOutcomeUnavailable: false,
    })
    expect(derived.replyBody).toBe('Tuesday at 18:00 works.')
    expect(derived.notice).toBe(false)
  })

  it('keeps the result delivery and flags a notice when the receipt body is a delivery update', () => {
    const receipt = parsed(receiptText('proc_0123456789ab', 'completed normally', '0', '{"delivery_id": "abc", "state": "handed off"}'))
    const derived = deriveState({ result: { status: 'sent', process_id: 'proc_0123456789ab' }, receipt, sendDone: true })
    expect(derived.notice).toBe(true)
    expect(derived.state.delivery).toBe('admitted')
    expect(derived.state.reply).toEqual({ kind: 'none' })
    expect(derived.state.worker).toEqual({ kind: 'exited', code: 0 })
    expect(derived.state.latestOutcomeUnavailable).toBe(true)
  })

  it('flags latestOutcomeUnavailable when the waiter is gone while delivery is still in flight', () => {
    const queuedBody = '{"status": "queued", "delivery_id": "abc"}'
    const exited = deriveState({ result: { status: 'sent', process_id: 'proc_0123456789ab' }, receipt: parsed(receiptText('proc_0123456789ab', 'exited', '1', queuedBody)), sendDone: true })
    expect(exited.state).toMatchObject({ delivery: 'queued', worker: { kind: 'exited', code: 1 }, latestOutcomeUnavailable: true })

    const lost = deriveState({ result: { status: 'sent', process_id: 'proc_0123456789ab' }, receipt: parsed(receiptText('proc_0123456789ab', 'marked lost because the process backend disappeared', '?', queuedBody)), sendDone: true })
    expect(lost.state).toMatchObject({ worker: { kind: 'lost' }, latestOutcomeUnavailable: true })

    const terminated = deriveState({ result: { status: 'sent', process_id: 'proc_0123456789ab' }, receipt: parsed(receiptText('proc_0123456789ab', 'terminated by the owner', '-15', queuedBody)), sendDone: true })
    expect(terminated.state).toMatchObject({ worker: { kind: 'terminated', by: 'the owner' }, latestOutcomeUnavailable: true })

    // a settled delivery is not "in flight", so a gone waiter changes nothing
    const settled = deriveState({ result: { status: 'sent', process_id: 'proc_0123456789ab' }, receipt: parsed(receiptText('proc_0123456789ab', 'exited', '0', 'Sure.')), sendDone: true })
    expect(settled.state.latestOutcomeUnavailable).toBe(false)
  })

  it('reads a damaged live payload as damaged when the paired result is the live-owner ack', () => {
    const fixture = receiptDamaged as unknown as ReceiptFixture
    const derived = deriveState({ result: fixture.result, receipt: parsed(fixture.text), sendDone: true })
    expect(derived.state.reply).toEqual({ kind: 'damaged' })
    expect(derived.state.delivery).toBe('unknown')
    expect(derived.evidence.deliveryId).toBe(fixture.result?.delivery_id)
  })

  it('reads a v0.21.6 CLI reply as settled text although its ack carries a delivery_id', () => {
    const parsed = parseReceiptRow(receiptCli.text)
    if (parsed.kind !== 'receipts') throw new Error('unreachable')
    const ack = { status: 'queued', delivery_id: 'a'.repeat(64), to: '@kevin', reply_delivery: 'notification', detail: 'Message queued for @kevin.', process_id: 'proc_782bd84d7f2a', queued_at: 1789375767 }
    expect(deriveState({ result: ack, receipt: parsed.receipts[0], sendDone: true }).state).toMatchObject({ delivery: 'settled', reply: { kind: 'text' } })
  })

  it('reads a cut v0.21.6 CLI reply as an excerpt and says Hermes shortened it', () => {
    const fixture = receiptCliCut as unknown as ReceiptFixture
    const receipt = parsed(fixture.text)
    const processId = receipt.headline.processId
    const { exchanges } = build(evidenceOf({
      sends: [sendEvidence({ toolCallId: 'call_k', anchorRowId: 40 })],
      results: [{ toolCallId: 'call_k', result: fixture.result, rowId: 41 }],
      receipts: [{ processId, receipt, rowId: 42, itemId: `h-receipt-42-${processId}` }],
    }))
    expect(exchanges[0]?.state).toMatchObject({ delivery: 'settled', reply: { kind: 'excerpt' }, worker: { kind: 'exited', code: 0 } })
    expect(exchanges[0]?.reply?.body).not.toContain('characters cut')
    expect(exchangeCopy(exchanges[0]!)).toBe('2 messages with Kevin · shortened by Hermes')
  })

  it('never throws on a result that is not an object', () => {
    expect(deriveState({ result: 'not json', sendDone: true }).state.delivery).toBe('unknown')
    expect(deriveState({ result: null, sendDone: true }).state.delivery).toBe('unknown')
  })
})

// ---------------------------------------------------------------------------
// buildExchanges: pairing by ids only (spec 5.5)
// ---------------------------------------------------------------------------

describe('buildExchanges', () => {
  it('builds the recorded outbound exchanges from the sender transcript', () => {
    const { exchanges, unpaired, needsOlder } = build(collectEvidence([], senderRows))

    expect(exchanges).toHaveLength(6)
    expect(exchanges.every(x => x.kind === 'exchange' && x.direction === 'outbound' && x.phase === 'settled' && x.pairing === 'paired')).toBe(true)
    expect(unpaired).toEqual([])
    expect(needsOlder).toBe(false)
  })

  it('settles the recorded CLI exchange with Kevin and reads its reply', () => {
    const { exchanges } = build(collectEvidence([], senderRows))
    const cli = exchangeById(exchanges, CLI_CALL_ID)

    expect(cli.id).toBe(`x-${CLI_CALL_ID}`)
    expect(cli.anchor).toEqual({ rowId: 94, toolCallId: CLI_CALL_ID })
    expect(cli.peer).toMatchObject({ handle: 'kevin', profile: 'kevin', display: { name: 'Kevin' } })
    expect(cli.state.delivery).toBe('settled')
    expect(cli.state.reply.kind).toBe('text')
    expect(cli.state.worker).toEqual({ kind: 'exited', code: 0 })
    expect(cli.reply?.body).toContain('Ik ben beschikbaar op:')
    expect(cli.reply?.body).not.toContain('session_id:')
    expect(cli.sent.text).toContain('availability')
    expect(cli.bodies).toBe(2)
    expect(cli.evidence).toMatchObject({ status: 'sent', processId: CLI_PROCESS_ID, provenance: 'structured' })
    expect(cli.members).toContain(`h-receipt-99-${CLI_PROCESS_ID}`)
    expect(exchangeCopy(cli)).toBe('2 messages with Kevin')
  })

  it('reads the recorded refusal for an unknown teammate as an unknown outcome (reason: unknown)', () => {
    const { exchanges } = build(collectEvidence([], senderRows))
    const refusal = exchangeById(exchanges, REFUSAL_CALL_ID)

    expect(refusal.peer).toEqual({ handle: 'zed', display: { name: 'zed' } })
    expect(refusal.state.delivery).toBe('unknown')
    expect(refusal.state.reply).toEqual({ kind: 'none' })
    expect(refusal.state.worker).toEqual({ kind: 'not_observed' })
    expect(refusal.evidence).toMatchObject({ reason: 'unknown' })
    expect(refusal.evidence.error).toContain("No teammate named 'zed'")
    expect(refusal.bodies).toBe(1)
    expect(exchangeCopy(refusal)).toBe('Delivery outcome unknown')
  })

  it('reads a typed refusal reason as refused and names the unresolved handle', () => {
    const evidence = evidenceOf({
      sends: [sendEvidence({ toolCallId: 'call_z', target: 'zed', message: 'Hello!', anchorRowId: 110 })],
      results: [{ toolCallId: 'call_z', result: { error: "Delivery failed: @zed's Bot Chat is open elsewhere.", reason: 'target_busy' }, rowId: 111 }],
    })
    const { exchanges } = build(evidence)
    expect(exchanges[0]?.state.delivery).toBe('refused')
    expect(exchanges[0]?.peer.display.name).toBe('zed')
    expect(exchangeCopy(exchanges[0]!)).toBe('zed could not be reached')
  })

  it('reads the synthetic refusal receipt paired with a spawn ack as refused', () => {
    const fixture = receiptRefusalJson as unknown as ReceiptFixture
    const receipt = parsed(fixture.text)
    const processId = receipt.headline.processId
    const evidence = evidenceOf({
      sends: [sendEvidence({ toolCallId: 'call_r', anchorRowId: 40 })],
      results: [{ toolCallId: 'call_r', result: fixture.result, rowId: 41 }],
      receipts: [{ processId, receipt, rowId: 42, itemId: `h-receipt-42-${processId}` }],
    })
    const { exchanges } = build(evidence)
    expect(exchanges[0]?.state).toMatchObject({ delivery: 'refused', worker: { kind: 'exited', code: 1 }, reply: { kind: 'none' } })
    expect(exchanges[0]?.evidence.reason).toBe('target_busy')
    expect(exchangeCopy(exchanges[0]!)).toBe('Kevin could not be reached')
  })

  it('shows a live send that has not completed as sending', () => {
    const items: ChatItem[] = [{ kind: 'tool', id: 'tool-call_live', toolId: 'call_live', name: 'message_agent', args: { target: 'kevin', message: 'Hi' }, done: false }]
    const { exchanges } = build(collectEvidence(items, []))

    expect(exchanges[0]).toMatchObject({ id: 'x-call_live', phase: 'sending', anchor: { toolCallId: 'call_live' }, members: ['tool-call_live'] })
    expect(exchanges[0]?.anchor.rowId).toBeUndefined()
    expect(exchanges[0]?.state).toEqual({ delivery: 'unknown', worker: { kind: 'not_observed' }, reply: { kind: 'none' }, latestOutcomeUnavailable: false })
    expect(exchangeCopy(exchanges[0]!)).toBe('Messaging Kevin…')
  })

  it('shows an admitted live send with a running waiter and no receipt yet', () => {
    const items: ChatItem[] = [{ kind: 'tool', id: 'tool-call_live', toolId: 'call_live', name: 'message_agent', args: { target: 'kevin', message: 'Hi' }, result: { status: 'sent', to: '@kevin', process_id: 'proc_0123456789ab' }, done: true }]
    const { exchanges } = build(collectEvidence(items, []))

    expect(exchanges[0]?.phase).toBe('settled')
    expect(exchanges[0]?.state).toMatchObject({ delivery: 'admitted', worker: { kind: 'running' }, reply: { kind: 'none' } })
    expect(exchanges[0]?.members).toEqual(['tool-call_live'])
    expect(exchangeCopy(exchanges[0]!)).toBe('Messaged Kevin')
  })

  it('pairs by ids only: a receipt for another process never lands on the send', () => {
    const receipt = parsed(receiptText('proc_ffffffffffff', 'completed normally', '0', 'Sure.'))
    const evidence = evidenceOf({
      sends: [sendEvidence({ toolCallId: 'call_1', anchorRowId: 10 })],
      results: [{ toolCallId: 'call_1', result: { status: 'sent', process_id: 'proc_0123456789ab' }, rowId: 11 }],
      receipts: [{ processId: 'proc_ffffffffffff', receipt, rowId: 12, itemId: 'h-receipt-12-proc_ffffffffffff' }],
    })
    const { exchanges, unpaired } = build(evidence)
    expect(exchanges[0]?.state.delivery).toBe('admitted')
    expect(exchanges[0]?.reply).toBeUndefined()
    expect(unpaired.map(u => u.processId)).toEqual(['proc_ffffffffffff'])
  })

  it('calls a receipt without a send unpaired inside a window that reached the start', () => {
    const receipt = parsed(receiptText('proc_ffffffffffff', 'completed normally', '0', 'Sure.'))
    const evidence = evidenceOf({ receipts: [{ processId: 'proc_ffffffffffff', receipt, rowId: 12, itemId: 'h-receipt-12-proc_ffffffffffff' }] })

    const reached = build(evidence, REACHED_START)
    expect(reached.exchanges).toEqual([])
    expect(reached.unpaired.map(u => u.pairing)).toEqual(['unpaired'])
    expect(reached.needsOlder).toBe(false)

    const mid = build(evidence, MID_WINDOW)
    expect(mid.unpaired.map(u => u.pairing)).toEqual(['not_loaded'])
    expect(mid.needsOlder).toBe(true)
  })

  it('asks for an older page at the recorded page boundary (page 1 holds the receipt, page 2 the send)', () => {
    const evidence = collectEvidence([], page1Rows)
    const mid = buildExchanges(evidence, { roster, window: { loaded: true, oldestLoadedRowId: 99, reachedStart: false } })

    expect(mid.needsOlder).toBe(true)
    expect(mid.unpaired.map(u => ({ processId: u.processId, pairing: u.pairing }))).toEqual([{ processId: CLI_PROCESS_ID, pairing: 'not_loaded' }])
    expect(mid.exchanges.map(x => x.anchor.rowId)).toEqual([102, 110, 114, 116])

    const reached = buildExchanges(evidence, { roster, window: { loaded: true, oldestLoadedRowId: 99, reachedStart: true } })
    expect(reached.needsOlder).toBe(false)
    expect(reached.unpaired.map(u => u.pairing)).toEqual(['unpaired'])
  })

  it('asks for an older page when a message_agent tool row lost its assistant row', () => {
    const content = '{"status": "sent", "to": "@kevin", "process_id": "proc_0123456789ab"}'
    const rows: TranscriptRow[] = [{ id: 103, role: 'tool', text: content, content, toolCallId: 'call_orphan', toolName: 'message_agent', result: { status: 'sent', process_id: 'proc_0123456789ab' } }]
    const evidence = collectEvidence([], rows)

    expect(evidence.sends).toEqual([])
    expect(evidence.results.map(r => r.toolCallId)).toEqual(['call_orphan'])
    const mid = buildExchanges(evidence, { roster, window: { loaded: true, oldestLoadedRowId: 103, reachedStart: false } })
    expect(mid.exchanges).toEqual([])
    expect(mid.needsOlder).toBe(true)
    expect(buildExchanges(evidence, { roster, window: { loaded: true, oldestLoadedRowId: 103, reachedStart: true } }).needsOlder).toBe(false)
  })

  it('never pages backward for a receipt that has not happened yet', () => {
    const evidence = evidenceOf({
      sends: [sendEvidence({ toolCallId: 'call_1', anchorRowId: 10 })],
      results: [{ toolCallId: 'call_1', result: { status: 'sent', process_id: 'proc_0123456789ab' }, rowId: 11 }],
    })
    expect(build(evidence, MID_WINDOW).needsOlder).toBe(false)
  })

  it('carries a delivery-update notice next to the exchange without changing its delivery', () => {
    const receipt = parsed(receiptText('proc_0123456789ab', 'completed normally', '0', '{"delivery_id": "abc", "state": "handed off"}'))
    const evidence = evidenceOf({
      sends: [sendEvidence({ toolCallId: 'call_1', anchorRowId: 10 })],
      results: [{ toolCallId: 'call_1', result: { status: 'sent', process_id: 'proc_0123456789ab' }, rowId: 11 }],
      receipts: [{ processId: 'proc_0123456789ab', receipt, rowId: 12, itemId: 'h-receipt-12-proc_0123456789ab' }],
    })
    const { exchanges } = build(evidence)
    expect(exchanges[0]?.notice).toBe(true)
    expect(exchanges[0]?.state.delivery).toBe('admitted')
    // the waiter exited without reporting an outcome, so the row says so (spec 5.3, last paragraph)
    expect(exchanges[0]?.state.latestOutcomeUnavailable).toBe(true)
    expect(exchangeCopy(exchanges[0]!)).toBe('Messaged Kevin · latest outcome unavailable')
  })

  it('appends the latest-outcome suffix when the waiter exited while the delivery was queued', () => {
    const receipt = parsed(receiptText('proc_0123456789ab', 'exited', '1', '{"status": "queued", "delivery_id": "abc"}'))
    const evidence = evidenceOf({
      sends: [sendEvidence({ toolCallId: 'call_1', anchorRowId: 10 })],
      results: [{ toolCallId: 'call_1', result: { status: 'sent', process_id: 'proc_0123456789ab' }, rowId: 11 }],
      receipts: [{ processId: 'proc_0123456789ab', receipt, rowId: 12, itemId: 'h-receipt-12-proc_0123456789ab' }],
    })
    const { exchanges } = build(evidence)
    expect(exchanges[0]?.state.latestOutcomeUnavailable).toBe(true)
    expect(exchangeCopy(exchanges[0]!)).toBe('Messaged Kevin · waiting for a reply · latest outcome unavailable')
  })

  it('pairs the two receipts of one batch row to their own sends by process id', () => {
    const batch = (receiptBatchTwo as unknown as ReceiptFixture).text
    const sendRow = (id: number, callId: string, message: string): TranscriptRow => ({ id, role: 'assistant', text: '', content: '', toolCalls: [{ id: callId, name: 'message_agent', args: { target: 'kevin', message } }] })
    const resultRow = (id: number, callId: string, processId: string): TranscriptRow => ({ id, role: 'tool', text: '', content: '', toolCallId: callId, toolName: 'message_agent', result: { status: 'sent', to: '@kevin', process_id: processId } })
    const rows: TranscriptRow[] = [
      sendRow(50, 'call_colour', 'What is your favorite color?'),
      resultRow(51, 'call_colour', 'proc_69dec248dc4e'),
      sendRow(52, 'call_food', 'What is your favorite food?'),
      resultRow(53, 'call_food', 'proc_8a312511b81e'),
      { id: 54, role: 'user', text: batch, content: batch },
    ]

    const { exchanges, unpaired, needsOlder } = build(collectEvidence([], rows))
    expect(unpaired).toEqual([])
    expect(needsOlder).toBe(false)
    expect(exchanges.map(x => x.evidence.processId)).toEqual(['proc_69dec248dc4e', 'proc_8a312511b81e'])
    expect(exchanges.every(x => x.state.delivery === 'settled' && x.state.reply.kind === 'text' && x.bodies === 2)).toBe(true)
    expect(exchanges[0]?.members).toContain('h-receipt-54-proc_69dec248dc4e')
    expect(exchanges[1]?.members).toContain('h-receipt-54-proc_8a312511b81e')
    expect(exchanges[0]?.reply?.body).not.toBe(exchanges[1]?.reply?.body)
  })

  it('gives two message_agent calls in one assistant row two exchanges on one anchor row', () => {
    const rows: TranscriptRow[] = [
      {
        id: 60,
        role: 'assistant',
        text: '',
        content: '',
        toolCalls: [
          { id: 'call_a', name: 'message_agent', args: { target: 'kevin', message: 'First' } },
          { id: 'call_b', name: 'message_agent', args: { target: 'kevin', message: 'Second' } },
        ],
      },
      { id: 61, role: 'tool', text: '', content: '', toolCallId: 'call_a', toolName: 'message_agent', result: { status: 'sent', process_id: 'proc_aaaaaaaaaaaa' } },
      { id: 62, role: 'tool', text: '', content: '', toolCallId: 'call_b', toolName: 'message_agent', result: { status: 'sent', process_id: 'proc_bbbbbbbbbbbb' } },
    ]

    const { exchanges } = build(collectEvidence([], rows))
    expect(exchanges.map(x => x.id)).toEqual(['x-call_a', 'x-call_b'])
    expect(exchanges.map(x => x.anchor)).toEqual([{ rowId: 60, toolCallId: 'call_a' }, { rowId: 60, toolCallId: 'call_b' }])
    expect(exchanges.map(x => x.sent.text)).toEqual(['First', 'Second'])
    expect(exchanges.map(x => x.evidence.processId)).toEqual(['proc_aaaaaaaaaaaa', 'proc_bbbbbbbbbbbb'])
  })

  it('keeps the second send of a two-send turn in flight while only the first has a result', () => {
    const rows: TranscriptRow[] = [
      {
        id: 60,
        role: 'assistant',
        text: '',
        content: '',
        toolCalls: [
          { id: 'call_a', name: 'message_agent', args: { target: 'kevin', message: 'First' } },
          { id: 'call_b', name: 'message_agent', args: { target: 'kevin', message: 'Second' } },
        ],
      },
      { id: 61, role: 'tool', text: '', content: '', toolCallId: 'call_a', toolName: 'message_agent', result: { status: 'sent', process_id: 'proc_aaaaaaaaaaaa' } },
    ]
    // The REST row of the turn already carries both calls; only the live item knows the second is running.
    const running: ChatItem[] = [{ kind: 'tool', id: 'tool-call_b', toolId: 'call_b', name: 'message_agent', args: { target: 'kevin', message: 'Second' }, done: false }]

    const { exchanges } = build(collectEvidence(running, rows))
    expect(exchanges.map(x => x.phase)).toEqual(['settled', 'sending'])
    expect(exchanges.map(x => exchangeCopy(x))).toEqual(['Messaged Kevin', 'Messaging Kevin…'])

    // The completion landed without a result: the send is done, and the outcome is honestly unknown.
    const done: ChatItem[] = [{ kind: 'tool', id: 'tool-call_b', toolId: 'call_b', name: 'message_agent', args: { target: 'kevin', message: 'Second' }, done: true }]
    const settled = build(collectEvidence(done, rows)).exchanges[1]
    expect(settled?.phase).toBe('settled')
    expect(settled?.state.delivery).toBe('unknown')
    expect(exchangeCopy(settled!)).toBe('Delivery outcome unknown')
  })

  it('settles a send whose tool.complete was missed but whose result the page holds', () => {
    const rows: TranscriptRow[] = [
      { id: 70, role: 'assistant', text: '', content: '', toolCalls: [{ id: 'call_c', name: 'message_agent', args: { target: 'kevin', message: 'Hi' } }] },
      { id: 71, role: 'tool', text: '', content: '', toolCallId: 'call_c', toolName: 'message_agent', result: { status: 'sent', process_id: 'proc_cccccccccccc' } },
    ]
    const stuck: ChatItem[] = [{ kind: 'tool', id: 'tool-call_c', toolId: 'call_c', name: 'message_agent', args: { target: 'kevin', message: 'Hi' }, done: false }]
    const exchange = build(collectEvidence(stuck, rows)).exchanges[0]
    expect(exchange?.phase).toBe('settled')
    expect(exchangeCopy(exchange!)).toBe('Messaged Kevin')
  })

  it('resolves a remote target through the peer rules', () => {
    const evidence = evidenceOf({ sends: [sendEvidence({ toolCallId: 'call_p', target: 'studio/kevin', message: 'Hi' })] })
    expect(build(evidence).exchanges[0]?.peer).toMatchObject({ remote: { peer: 'studio', agent: 'kevin' }, display: { name: '@kevin on studio' } })
  })
})

// ---------------------------------------------------------------------------
// Copy (spec 5.4)
// ---------------------------------------------------------------------------

describe('exchangeCopy', () => {
  function state(over: Partial<ExchangeState>): ExchangeState {
    return { delivery: 'unknown', worker: { kind: 'not_observed' }, reply: { kind: 'none' }, latestOutcomeUnavailable: false, ...over }
  }
  function copy(over: Partial<Pick<Exchange, 'state' | 'phase' | 'peer' | 'bodies' | 'pairing'>>): string {
    return exchangeCopy({ state: state({}), phase: 'settled', peer: kevinPeer, bodies: 1, pairing: 'paired', ...over })
  }

  const rows: [string, Partial<Pick<Exchange, 'state' | 'phase' | 'bodies'>>, string][] = [
    ['sending', { phase: 'sending' }, 'Messaging Kevin…'],
    ['admitted, none', { state: state({ delivery: 'admitted' }) }, 'Messaged Kevin'],
    ['queued, none', { state: state({ delivery: 'queued' }) }, 'Messaged Kevin · waiting for a reply'],
    ['claimed, none', { state: state({ delivery: 'claimed' }) }, 'Messaged Kevin · waiting for a reply'],
    ['settled, text', { state: state({ delivery: 'settled', reply: { kind: 'text', body: 'ok', completeness: 'unknown' } }), bodies: 2 }, '2 messages with Kevin'],
    ['settled, excerpt', { state: state({ delivery: 'settled', reply: { kind: 'excerpt', body: 'ok' } }), bodies: 2 }, '2 messages with Kevin · shortened by Hermes'],
    ['settled, empty', { state: state({ delivery: 'settled', reply: { kind: 'empty' } }) }, 'Messaged Kevin · no reply text'],
    ['settled, damaged', { state: state({ delivery: 'settled', reply: { kind: 'damaged' } }) }, 'Kevin replied · the reply could not be read'],
    ['refused', { state: state({ delivery: 'refused' }) }, 'Kevin could not be reached'],
    ['failed', { state: state({ delivery: 'failed' }) }, 'Delivery failed'],
    ['cancelled', { state: state({ delivery: 'cancelled' }) }, 'Delivery cancelled'],
    ['unknown, none', { state: state({ delivery: 'unknown' }) }, 'Delivery outcome unknown'],
    ['unknown, damaged', { state: state({ delivery: 'unknown', reply: { kind: 'damaged' } }) }, 'Delivery update could not be read'],
    ['admitted + latestOutcomeUnavailable', { state: state({ delivery: 'admitted', latestOutcomeUnavailable: true }) }, 'Messaged Kevin · latest outcome unavailable'],
    ['queued + latestOutcomeUnavailable', { state: state({ delivery: 'queued', latestOutcomeUnavailable: true }) }, 'Messaged Kevin · waiting for a reply · latest outcome unavailable'],
    ['settled text + latestOutcomeUnavailable', { state: state({ delivery: 'settled', reply: { kind: 'text', body: 'ok', completeness: 'unknown' }, latestOutcomeUnavailable: true }), bodies: 2 }, '2 messages with Kevin · latest outcome unavailable'],
    ['unknown + latestOutcomeUnavailable', { state: state({ latestOutcomeUnavailable: true }) }, 'Delivery outcome unknown · latest outcome unavailable'],
  ]

  it.each(rows)('renders %s', (_label, over, expected) => {
    expect(copy(over)).toBe(expected)
  })

  it('counts the bodies the app holds', () => {
    const settledText = state({ delivery: 'settled', reply: { kind: 'text', body: 'ok', completeness: 'unknown' } })
    expect(copy({ state: settledText, bodies: 4 })).toBe('4 messages with Kevin')
  })

  it('uses the roster display name, never the handle or profile id', () => {
    expect(copy({ state: state({ delivery: 'admitted' }), peer: { handle: 'kevin', profile: 'kevin', display: { name: 'Kevin' } } })).toBe('Messaged Kevin')
    expect(copy({ state: state({ delivery: 'admitted' }), peer: { handle: 'zed', display: { name: 'zed' } } })).toBe('Messaged zed')
  })

  it('never renders a blank name: an empty target falls back to the handle, then to a generic name', () => {
    const admitted = state({ delivery: 'admitted' })
    expect(copy({ state: admitted, peer: { handle: 'zed', display: { name: '' } } })).toBe('Messaged zed')
    expect(copy({ state: admitted, peer: { handle: '', display: { name: '' } } })).toBe('Messaged an unknown teammate')
    expect(copy({ phase: 'sending', peer: { handle: '', display: { name: '' } } })).toBe('Messaging an unknown teammate…')

    const evidence = evidenceOf({
      sends: [sendEvidence({ toolCallId: 'call_blank', target: '', message: 'Hi' })],
      results: [{ toolCallId: 'call_blank', result: { status: 'sent' }, rowId: 11 }],
    })
    expect(exchangeCopy(buildExchanges(evidence, { roster, window: REACHED_START }).exchanges[0]!)).toBe('Messaged an unknown teammate')
  })

  it('falls back to the unknown outcome for any combination the table does not name', () => {
    expect(copy({ state: state({ delivery: 'admitted', reply: { kind: 'damaged' } }) })).toBe('Delivery outcome unknown')
    expect(copy({ state: state({ delivery: 'settled', reply: { kind: 'none' } }) })).toBe('Delivery outcome unknown')
  })
})

// ---------------------------------------------------------------------------
// mergeConsecutive (spec 5.4): the bodies of merged exchanges add up into the row's count
// ---------------------------------------------------------------------------

describe('mergeConsecutive', () => {
  function settledExchange(suffix: string, rowId: number): Exchange {
    const receipt = parsed(receiptText(`proc_00000000000${suffix}`, 'completed normally', '0', `Reply ${suffix}`))
    const evidence = evidenceOf({
      sends: [sendEvidence({ toolCallId: `call_${suffix}`, anchorRowId: rowId, message: `Ping ${suffix}` })],
      results: [{ toolCallId: `call_${suffix}`, result: { status: 'sent', process_id: `proc_00000000000${suffix}` }, rowId: rowId + 1 }],
      receipts: [{ processId: `proc_00000000000${suffix}`, receipt, rowId: rowId + 2, itemId: `h-receipt-${rowId + 2}-proc_00000000000${suffix}` }],
    })
    return build(evidence).exchanges[0]!
  }

  it('sums the bodies, keeps the first anchor and concatenates the folded members', () => {
    const a = settledExchange('1', 10)
    const b = settledExchange('2', 20)
    expect(a.bodies).toBe(2)

    const merged = mergeConsecutive(a, b)
    expect(merged.id).toBe(a.id)
    expect(merged.anchor).toEqual(a.anchor)
    expect(merged.sent).toEqual(a.sent)
    expect(merged.bodies).toBe(4)
    expect(merged.state).toEqual(b.state)
    expect(merged.phase).toBe(b.phase)
    expect(merged.reply).toEqual(b.reply)
    expect(merged.members).toEqual([...a.members, ...b.members])
    expect(exchangeCopy(merged)).toBe('4 messages with Kevin')
  })

  it('takes the later exchange phase and state, so a merge with a sending exchange still reads as sending', () => {
    const a = settledExchange('1', 10)
    const items: ChatItem[] = [{ kind: 'tool', id: 'tool-call_live', toolId: 'call_live', name: 'message_agent', args: { target: 'kevin', message: 'Hi' }, done: false }]
    const b = build(collectEvidence(items, [])).exchanges[0]!

    const merged = mergeConsecutive(a, b)
    expect(merged.phase).toBe('sending')
    expect(merged.reply).toBeUndefined()
    expect(merged.group?.count).toBe(2)
    // A merged row always counts its bodies; the unsettled last exchange adds a short state suffix.
    expect(exchangeCopy(merged)).toBe('3 messages with Kevin · 1 waiting')
  })

  it('reads a merged row as N messages with a per-member suffix (spec 12.4)', () => {
    const a = settledExchange('1', 10)
    const waiting = { ...settledExchange('2', 20), state: { delivery: 'queued' as const, worker: { kind: 'running' as const }, reply: { kind: 'none' as const }, latestOutcomeUnavailable: false } }
    delete (waiting as { reply?: unknown }).reply
    expect(exchangeCopy(mergeConsecutive(a, waiting))).toBe('4 messages with Kevin · 1 waiting')
    const refused = { ...settledExchange('3', 30), state: { delivery: 'refused' as const, worker: { kind: 'not_observed' as const }, reply: { kind: 'none' as const }, latestOutcomeUnavailable: false } }
    expect(exchangeCopy(mergeConsecutive(a, refused))).toBe('4 messages with Kevin · 1 refused')
    expect(exchangeCopy(mergeConsecutive(a, settledExchange('4', 40)))).toBe('4 messages with Kevin')
    expect(exchangeCopy(settledExchange('5', 50))).toBe('2 messages with Kevin')
  })
})

// ---------------------------------------------------------------------------
// identities (spec 12.1) and member states / openability / per-member suffix (spec 12.4)
// ---------------------------------------------------------------------------

describe('identities (spec 12.1)', () => {
  const base = { anchor: { toolCallId: 'call_1', rowId: 10 }, direction: 'outbound' as const, evidence: {} as Exchange['evidence'] }
  const st = (over: Partial<ExchangeState>): ExchangeState => ({ delivery: 'unknown', worker: { kind: 'not_observed' }, reply: { kind: 'none' }, latestOutcomeUnavailable: false, ...over })

  it('gives a send, its outcome and its return distinct stable ids', () => {
    const ids = exchangeIdentities({ ...base, phase: 'settled', state: st({ delivery: 'settled', reply: { kind: 'text', body: 'ok', completeness: 'unknown' } }), reply: { body: 'ok' }, evidence: { processId: 'proc_1' } })
    expect(ids).toEqual(['send:call_1', 'outcome:call_1:settled:settled:text:false', 'return:proc_1'])
    expect(exchangeIdentities({ ...base, phase: 'settled', state: st({ delivery: 'settled', reply: { kind: 'text', body: 'ok', completeness: 'unknown' } }), reply: { body: 'ok' }, evidence: { processId: 'proc_1' } })).toEqual(ids)
  })

  it('a phase-only change is a new identity, and so is a latestOutcomeUnavailable flip', () => {
    const sending = exchangeIdentities({ ...base, phase: 'sending', state: st({}) })
    const unknown = exchangeIdentities({ ...base, phase: 'settled', state: st({}) })
    expect(sending).toEqual(['send:call_1', 'outcome:call_1:sending:unknown:none:false'])
    expect(unknown).toEqual(['send:call_1', 'outcome:call_1:settled:unknown:none:false'])
    const flipped = exchangeIdentities({ ...base, phase: 'settled', state: st({ latestOutcomeUnavailable: true }) })
    expect(flipped[1]).toBe('outcome:call_1:settled:unknown:none:true')
  })

  it('a refused send without a process id still has an identity', () => {
    const evidence = evidenceOf({ sends: [sendEvidence({ toolCallId: 'call_r', anchorRowId: 11 })], results: [{ toolCallId: 'call_r', result: { error: 'busy', reason: 'target_busy' }, rowId: 12 }] })
    const [x] = build(evidence).exchanges
    expect(x!.identities).toEqual(['send:call_r', 'outcome:call_r:settled:refused:none:false'])
  })

  it('an inbound fold carries the answer row id only', () => {
    expect(exchangeIdentities({ anchor: { rowId: 31 }, direction: 'inbound', phase: 'settled', state: st({ delivery: 'settled' }), evidence: {}, answerRowId: 32 })).toEqual(['answer:32'])
  })
})

describe('member states, openability and the merged suffix (spec 12.4)', () => {
  function settledExchange(suffix: string, rowId: number): Exchange {
    const receipt = parsed(receiptText(`proc_00000000000${suffix}`, 'completed normally', '0', `Reply ${suffix}`))
    const evidence = evidenceOf({
      sends: [sendEvidence({ toolCallId: `call_${suffix}`, anchorRowId: rowId, message: `Ping ${suffix}` })],
      results: [{ toolCallId: `call_${suffix}`, result: { status: 'sent', process_id: `proc_00000000000${suffix}` }, rowId: rowId + 1 }],
      receipts: [{ processId: `proc_00000000000${suffix}`, receipt, rowId: rowId + 2, itemId: `h-receipt-${rowId + 2}-proc_00000000000${suffix}` }],
    })
    return build(evidence).exchanges[0]!
  }
  const withState = (x: Exchange, state: Partial<ExchangeState>): Exchange => {
    const next: Exchange = { ...x, state: { ...x.state, ...state } }
    if (state.reply !== undefined && state.reply.kind !== 'text' && state.reply.kind !== 'excerpt') delete next.reply
    return next
  }
  const sending = (): Exchange => build(collectEvidence([{ kind: 'tool', id: 'tool-call_live', toolId: 'call_live', name: 'message_agent', args: { target: 'kevin', message: 'Hi' }, done: false }], [])).exchanges[0]!

  it('a merged row with a sending newest member is openable; a lone sending row is not', () => {
    const merged = mergeConsecutive(settledExchange('1', 10), sending())
    expect(isOpenable(merged)).toBe(true)
    expect(isOpenable(sending())).toBe(false)
    expect(isOpenable(settledExchange('2', 20))).toBe(true)
    expect(memberStates(merged)).toHaveLength(2)
    expect(merged.identities).toEqual([...settledExchange('1', 10).identities, ...sending().identities])
  })

  it('counts every member state in the suffix, in the order waiting, failed, refused, cancelled, unknown', () => {
    const a = settledExchange('1', 10)
    const waiting = withState(settledExchange('2', 20), { delivery: 'queued', reply: { kind: 'none' } })
    const failed = withState(settledExchange('3', 30), { delivery: 'failed', reply: { kind: 'none' } })
    const refused = withState(settledExchange('4', 40), { delivery: 'refused', reply: { kind: 'none' } })
    const cancelled = withState(settledExchange('5', 50), { delivery: 'cancelled', reply: { kind: 'none' } })
    const unavailable = withState(settledExchange('6', 60), { latestOutcomeUnavailable: true })

    // `bodies` sums the two exchanges' own stored counts (brief step 3: mergeConsecutive keeps
    // `bodies: a.bodies + b.bodies`); `withState` only overrides `state`, so a member whose bodies
    // were fixed at build time (2: sent + settled reply) keeps counting 2 even once its `state` is
    // overridden to look unsettled for this test. Verified against the implementation, not assumed.
    expect(exchangeCopy(mergeConsecutive(waiting, failed))).toBe('4 messages with Kevin · 1 waiting · 1 failed')
    const all = [failed, refused, cancelled, unavailable, sending()].reduce(mergeConsecutive, mergeConsecutive(a, waiting))
    expect(exchangeCopy(all)).toBe('13 messages with Kevin · 2 waiting · 1 failed · 1 refused · 1 cancelled · 1 unknown')
    // a settled member is not counted; a merged row does not repeat the latest-outcome suffix
    expect(exchangeCopy(mergeConsecutive(a, settledExchange('7', 70)))).toBe('4 messages with Kevin')
    expect(exchangeCopy(mergeConsecutive(a, unavailable))).toBe('4 messages with Kevin · 1 unknown')
    // a damaged reply counts as unknown
    expect(exchangeCopy(mergeConsecutive(a, withState(settledExchange('8', 80), { reply: { kind: 'damaged' } })))).toBe('4 messages with Kevin · 1 unknown')
  })
})
