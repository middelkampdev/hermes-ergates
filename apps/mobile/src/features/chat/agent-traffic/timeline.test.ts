import { describe, expect, it } from 'vitest'

import type { HistoryMessage, TranscriptRow } from '@/gateway/types'
import { formatClock, formatDateSeparator } from '@/lib/time'

import { historyToItems, type ChatItem } from '../history'
import type { LiveTurn } from '../session-reducer'

import { peerKey } from './peers'
import { parseReceiptRow } from './receipt'
import { acknowledgementBatch, activityEntries, buildTimeline, exchangeTranscript, identitiesOf, unpresentedOlder, workingLineText, TIME_GAP_S, type Line, type TimelineInput, type TranscriptEntry } from './timeline'
import { normalizeTranscriptPage } from './transcript'
import type { RosterPeer } from './types'

import historyReceiver from '@test/fixtures/agent-traffic/history-receiver.json'
import historySender from '@test/fixtures/agent-traffic/history-sender.json'
import receiptCliCut from '@test/fixtures/agent-traffic/receipt-cli-cut.json'
import senderPage from '@test/fixtures/agent-traffic/transcript-sender.json'

const ROSTER: RosterPeer[] = [
  { profile: 'default', name: 'Hermes', hasAvatar: true },
  { profile: 'kevin', name: 'Kevin', hasAvatar: true },
]

const IDLE: LiveTurn = { streaming: false, assistantText: '', reasoningText: '', statusLine: null, turnStartedAt: null, ownership: null }

/** A fixed "now" keeps the date separators deterministic wherever the suite runs. */
const NOW = Date.parse('2026-09-14T20:00:00Z')

function input(over: Partial<TimelineInput> = {}): TimelineInput {
  return {
    items: [],
    rows: [],
    window: { loaded: true, oldestLoadedRowId: null, reachedStart: true, error: null },
    roster: ROSTER,
    selfProfile: 'default',
    selfName: 'Hermes',
    live: IDLE,
    inflightError: null,
    idleConfirmed: true,
    acknowledged: [],
    now: NOW,
    ...over,
  }
}

const senderItems = (): ChatItem[] => historyToItems(historySender.messages as HistoryMessage[])
const senderRows = (): TranscriptRow[] => normalizeTranscriptPage(senderPage as never).rows
const receiverItems = (): ChatItem[] => historyToItems(historyReceiver.messages as HistoryMessage[])

const keys = (lines: Line[]): string[] => lines.map(line => line.key)
const kinds = (lines: Line[], kind: Line['kind']): Line[] => lines.filter(line => line.kind === kind)
const texts = (lines: Line[]): string[] => lines.flatMap(line => ('text' in line ? [line.text] : []))

/** Every string this module puts in front of a reader (docs/04: never a receipt, a command or a path). */
function visibleStrings(lines: Line[]): string[] {
  const out: string[] = []
  for (const line of lines) {
    if ('text' in line) out.push(line.text)
    if ('label' in line) out.push(line.label)
  }
  return out
}

const SENT_RESULT = (processId: string) => ({ status: 'sent', to: '@kevin', process_id: processId, sent_at: 1 })

/** A recorded-shape receipt row: headline, command line and body, exactly as the backend prints it. */
function receiptText(processId: string, body: string): string {
  return `[IMPORTANT: Background process ${processId} completed normally (exit code 0).\nCommand: /opt/data/hermes/venv/bin/python /opt/data/hermes/tools/bot_mode_dm.py --run-delivery\nOutput:\n${body}]`
}

/** One `message_agent` send as the REST page carries it: an assistant row with the call, then its tool row. */
function sendRows(opts: { row: number; callId: string; message: string; at: number; processId?: string }): TranscriptRow[] {
  const result = opts.processId === undefined ? { error: 'nope', reason: 'unknown' } : SENT_RESULT(opts.processId)
  return [
    { id: opts.row, role: 'assistant', text: '', content: '', at: opts.at, toolCalls: [{ id: opts.callId, name: 'message_agent', args: { target: 'kevin', message: opts.message } }] },
    { id: opts.row + 1, role: 'tool', text: '', content: '', at: opts.at, toolCallId: opts.callId, toolName: 'message_agent', result },
  ]
}

function receiptRow(id: number, processId: string, body: string, at: number): TranscriptRow {
  const text = receiptText(processId, body)
  return { id, role: 'user', text, content: text, at }
}

describe('buildTimeline: sender timeline (spec 5.7, 5.9)', () => {
  const result = () => buildTimeline(input({ items: senderItems(), rows: senderRows() }))

  it('never renders a receipt item or an id-less message_agent tool row', () => {
    const { lines } = result()
    expect(lines.some(line => line.key.startsWith('h-receipt-'))).toBe(false)
    expect(kinds(lines, 'tool').some(line => line.kind === 'tool' && line.item.name === 'message_agent')).toBe(false)
    // the other tool rows are still there, labelled without their arguments
    expect(kinds(lines, 'tool').map(line => (line.kind === 'tool' ? line.label : ''))).toContain('Used skill_view')
  })

  it('places each exchange after its anchor row and keeps the assistant answer after it', () => {
    const { lines } = result()
    const exchanges = kinds(lines, 'exchange')
    // Five outbound sends (the last two merged). Kevin's deliveries at rows 97, 105 and 119 answer a
    // dispatch of this bot: each is a compact "Message from Kevin" row and the report after it stays a
    // bubble (spec 13, Desktop parity, #114629). Row 123 is a second delivery with no new dispatch
    // before it, so that turn still folds.
    expect(exchanges.map(line => line.key)).toEqual([
      'x-call_Nfx9qJkrcOBUSpNkVll8VCEm',
      'x-call_W7BH7HW4zAEwvNbj4kNYzWUh',
      'x-msg-h-bot-97',
      'x-call_B0fvHiZUchl0fdsEWOqZbJfA',
      'x-msg-h-bot-105',
      'x-call_pJm7ALPH5a9L1p3dfWebcHV4',
      'x-call_nRwha9TQ0oE9AugWq67WcB4K',
      'x-msg-h-bot-119',
      'x-in-h-bot-123',
    ])
    expect(exchanges.map(line => (line.kind === 'exchange' ? line.text : ''))).toEqual([
      '2 messages with Kevin',
      '2 messages with Kevin',
      'Message from Kevin',
      '2 messages with Kevin',
      'Message from Kevin',
      'Delivery outcome unknown',
      '4 messages with Kevin',
      'Message from Kevin',
      '2 messages with Kevin',
    ])
    for (const report of ['h-assistant-98', 'h-assistant-106', 'h-assistant-120']) {
      expect(keys(lines)).toContain(report)
      expect(lines[keys(lines).indexOf(report) - 1]).toMatchObject({ kind: 'exchange', text: 'Message from Kevin' })
    }

    const first = lines.findIndex(line => line.key === 'x-call_Nfx9qJkrcOBUSpNkVll8VCEm')
    expect(lines[first - 1]?.key).toBe('h-user-87')
    expect(lines[first + 1]?.key).toBe('h-assistant-90')
  })

  it('drops the reasoning-only assistant rows that carried the tool calls', () => {
    const { lines } = result()
    expect(keys(lines)).not.toContain('h-assistant-88')
    expect(keys(lines)).not.toContain('h-assistant-94')
    expect(keys(lines)).toContain('h-assistant-90')
  })

  it('labels an exchange as openable, and never offers a send still in flight', () => {
    const { lines } = result()
    const exchange = lines.find(line => line.key === 'x-call_Nfx9qJkrcOBUSpNkVll8VCEm')
    expect(exchange).toMatchObject({ kind: 'exchange', openable: true, label: 'New activity. 2 messages with Kevin. Opens the messages with Kevin' })

    const sending: ChatItem[] = [{ kind: 'tool', id: 'live-tool-1', toolId: 'call_live', name: 'message_agent', args: { target: 'kevin', message: 'hi' }, done: false }]
    const live = buildTimeline(input({ items: sending })).lines.find(line => line.kind === 'exchange')
    expect(live).toMatchObject({ kind: 'exchange', openable: false, text: 'Messaging Kevin…', label: 'New activity. Messaging Kevin…' })
  })

  it('puts a date separator in front of the first line of each day', () => {
    const { lines } = result()
    const separators = kinds(lines, 'date').map(line => (line.kind === 'date' ? line.label : ''))
    expect(separators.length).toBeGreaterThanOrEqual(2)
    expect(new Set(separators).size).toBe(separators.length)
    expect(separators.at(-1)).toBe(formatDateSeparator(1789375917, new Date(NOW)))
    // every separator is followed by a line it dates
    for (const [i, line] of lines.entries()) {
      if (line.kind === 'date') expect(lines[i + 1]?.kind).not.toBe('date')
    }
  })

  it('never leaks receipt text, commands, paths or process ids into a line or a label', () => {
    const { lines } = result()
    for (const value of visibleStrings(lines)) {
      for (const forbidden of ['[IMPORTANT:', 'Command:', '/opt/data', 'Output:', 'proc_']) {
        expect(value).not.toContain(forbidden)
      }
    }
  })

  it('reports the window as complete and the exchanges it holds', () => {
    const built = result()
    expect(built.needsOlder).toBe(false)
    // six sends, three teammate answers (rows 97, 105, 119) and the one inbound turn that still folds (row 123)
    expect(built.exchanges).toHaveLength(10)
    expect(built.hasActivity).toBe(true)
  })
})

describe('buildTimeline: receiver-side collapse (spec 5.7)', () => {
  it('folds an inbound row and its answer into one inbound exchange', () => {
    const items = receiverItems()
    const { lines, exchanges } = buildTimeline(input({ items }))

    // Two consecutive folded turns sum up into one row (owner request 2026-09-14); the folds themselves stay separate in `exchanges`.
    // The turns at rows 19, 23 and 27 follow a `message_agent` send of this bot to Hermes, so their answers stay bubbles
    // (Desktop parity, #114629); the inbound row 19 draws no line of its own and sums into the same row (spec 13).
    const line = lines.find(l => l.key === 'x-in-h-bot-11')
    expect(line?.kind).toBe('exchange')
    if (line?.kind !== 'exchange') return
    expect(line.text).toBe('5 messages with Hermes')
    expect(line.exchange.group?.count).toBe(3)
    expect(exchanges.find(x => x.id === 'x-in-h-bot-11')).toMatchObject({
      kind: 'exchange',
      id: 'x-in-h-bot-11',
      direction: 'inbound',
      peer: { handle: 'hermes', profile: 'default', display: { name: 'Hermes' } },
      sent: { text: (items[8] as Extract<ChatItem, { kind: 'bot_message' }>).text },
      reply: { body: (items[9] as Extract<ChatItem, { kind: 'assistant' }>).text },
      state: { delivery: 'settled', worker: { kind: 'not_observed' }, reply: { kind: 'text', completeness: 'complete' }, latestOutcomeUnavailable: false },
      phase: 'settled',
      pairing: 'paired',
      bodies: 2,
      members: ['h-bot-11', 'h-assistant-12'],
      evidence: { provenance: 'inferred' },
      notice: false,
    })

    // the bot message and the answer are gone from the timeline
    expect(keys(lines)).not.toContain('h-bot-11')
    expect(keys(lines)).not.toContain('h-assistant-12')
  })

  it('hides the reasoning rows and tool rows of a folded turn but keeps chronology', () => {
    const { lines } = buildTimeline(input({ items: receiverItems() }))
    for (const hidden of ['h-bot-13', 'h-assistant-14', 'h-tool-1-terminal', 'h-assistant-16', 'h-tool-2-message_agent', 'h-assistant-18']) {
      expect(keys(lines)).not.toContain(hidden)
    }
    expect(kinds(lines, 'exchange').map(line => line.key)).toEqual(['x-in-h-bot-11', 'x-msg-h-bot-23', 'x-msg-h-bot-27'])
    expect(buildTimeline(input({ items: receiverItems() })).exchanges.map(x => x.id)).toEqual(['x-in-h-bot-11', 'x-in-h-bot-13', 'x-msg-h-bot-19', 'x-msg-h-bot-23', 'x-msg-h-bot-27'])
    expect(lines.findIndex(l => l.key === 'x-in-h-bot-11')).toBeGreaterThan(lines.findIndex(l => l.key === 'h-assistant-10'))
  })

  it('sums consecutive folded turns into one row: a folded bot message draws no line, so it does not break the run', () => {
    const { lines } = buildTimeline(input({ items: receiverItems() }))
    expect(kinds(lines, 'exchange').map(line => (line.kind === 'exchange' ? line.text : ''))).toEqual(['5 messages with Hermes', 'Message from Hermes', 'Message from Hermes'])
  })

  /** The receiver chat up to the answer of the turn row 13 started: that turn is then the last one, and it folds unless a rule forbids it. */
  const untilRow18 = (): ChatItem[] => {
    const items = receiverItems()
    return items.slice(0, items.findIndex(item => item.id === 'h-assistant-18') + 1)
  }

  it('stays expanded when a tool row follows the answer inside the turn', () => {
    expect(keys(buildTimeline(input({ items: untilRow18() })).lines)).toContain('x-in-h-bot-11')
    expect(buildTimeline(input({ items: untilRow18() })).exchanges.map(x => x.id)).toContain('x-in-h-bot-13')

    const items: ChatItem[] = [...untilRow18(), { kind: 'tool', id: 'h-tool-9-terminal', name: 'terminal', done: true }]
    const { lines, exchanges } = buildTimeline(input({ items }))
    expect(exchanges.map(x => x.id)).not.toContain('x-in-h-bot-13')
    const bot = lines.find(line => line.key === 'h-bot-13')
    expect(bot?.kind).toBe('bot_message')
    if (bot?.kind === 'bot_message') {
      expect(bot.peer.display.name).toBe('Hermes')
      expect(bot.label).toBe(`Hermes: ${bot.item.text}`)
    }
    expect(keys(lines)).toContain('h-assistant-18')
    expect(keys(lines)).toContain('h-tool-9-terminal')
    // the earlier turn still folds
    expect(lines.find(line => line.key === 'x-in-h-bot-11')).toMatchObject({ kind: 'exchange', text: '2 messages with Hermes' })
  })

  it('stays expanded while the last turn is still streaming, and when it failed', () => {
    const streaming = buildTimeline(input({ items: untilRow18(), live: { ...IDLE, streaming: true } }))
    expect(streaming.exchanges.map(x => x.id)).not.toContain('x-in-h-bot-13')
    expect(keys(streaming.lines)).toContain('h-bot-13')
    expect(keys(streaming.lines)).toContain('x-in-h-bot-11')

    const failed = buildTimeline(input({ items: untilRow18(), inflightError: 'socket closed', idleConfirmed: false }))
    expect(failed.exchanges.map(x => x.id)).not.toContain('x-in-h-bot-13')
    expect(keys(failed.lines)).toContain('h-bot-13')
  })

  it('never folds a turn that holds a pending card or an errored assistant row', () => {
    const base = receiverItems().slice(0, 10)
    const card: ChatItem = { kind: 'clarify', id: 'c1', requestId: 'r1', questions: [], state: 'pending' }
    const withCard = buildTimeline(input({ items: [...base.slice(0, 9), card, base[9]!] }))
    expect(keys(withCard.lines)).not.toContain('x-in-h-bot-11')
    expect(keys(withCard.lines)).toContain('h-bot-11')

    const errored = base.map(item => (item.id === 'h-assistant-12' ? { ...item, error: 'boom' } : item))
    const withError = buildTimeline(input({ items: errored }))
    expect(keys(withError.lines)).not.toContain('x-in-h-bot-11')
  })
})

describe("buildTimeline: the answer to this bot's own dispatch stays expanded (Hermes Desktop parity, #114629)", () => {
  const at = 1789375800
  const human = (row: number, text: string): ChatItem => ({ kind: 'user', id: `h-user-${row}`, rowId: row, text, at: at + row, delivery: 'acknowledged' })
  const dispatch = (n: number, target: string): ChatItem => ({ kind: 'tool', id: `h-tool-${n}-message_agent`, name: 'message_agent', args: { target, message: 'send me the list' }, done: true })
  const inbound = (row: number, text: string): ChatItem => ({ kind: 'bot_message', id: `h-bot-${row}`, rowId: row, handle: 'kevin', name: 'Kevin', text, at: at + row, provenance: 'inferred' })
  const says = (row: number, text: string): ChatItem => ({ kind: 'assistant', id: `h-assistant-${row}`, rowId: row, text, at: at + row })
  /** A closing human turn, so the turn under test is historical and would fold on inference. */
  const closing = (row: number): ChatItem[] => [human(row, 'ok thanks'), says(row + 1, 'anytime')]

  it('keeps the report to the human expanded when the inbound row answers a dispatch of this bot', () => {
    const items = [human(1, 'ask Kevin for the list'), dispatch(1, '@kevin'), says(3, 'I asked Kevin.'), inbound(4, 'here is the list'), says(5, 'Kevin sent the list.'), ...closing(6)]
    const { lines } = buildTimeline(input({ items }))
    expect(keys(lines)).not.toContain('x-in-h-bot-4')
    expect(keys(lines)).toContain('h-assistant-5')
  })

  it("draws the teammate's answer as a compact 'Message from <peer>' row, as Desktop does, and keeps it in the read-only transcript", () => {
    const items = [human(1, 'ask Kevin for the list'), dispatch(1, '@kevin'), says(3, 'I asked Kevin.'), inbound(4, 'here is the list'), says(5, 'Kevin sent the list.'), ...closing(6)]
    const result = buildTimeline(input({ items }))
    const row = result.lines.find(line => line.key === 'x-msg-h-bot-4')
    expect(row).toMatchObject({ kind: 'exchange', text: 'Message from Kevin', openable: true, marked: true })
    expect(keys(result.lines)).not.toContain('h-bot-4')
    // the report to the human is still a full bubble, right after the row
    expect(keys(result.lines)[keys(result.lines).indexOf('x-msg-h-bot-4') + 1]).toBe('h-assistant-5')

    const { entries } = exchangeTranscript(result, { peerKey: 'local:kevin' })
    expect(entries).toMatchObject([{ kind: 'message', role: 'inbound', roleLabel: 'Message from Kevin', text: 'here is the list', identities: ['inbound:4'] }])
    expect(entries[0]?.kind === 'message' && entries[0].stateText).toBeUndefined()
    expect(buildTimeline(input({ items, acknowledged: ['inbound:4'] })).lines.find(line => line.key === 'x-msg-h-bot-4')).toMatchObject({ marked: false })
  })

  it.each(['Kevin', '@Kevin', 'kevin@laptop', 'peer/kevin'])('matches the target %s against the handle or the display name', target => {
    const items = [human(1, 'ask Kevin'), dispatch(1, target), says(3, 'Asked.'), inbound(4, 'the answer'), says(5, 'Kevin says: the answer.'), ...closing(6)]
    expect(keys(buildTimeline(input({ items })).lines)).not.toContain('x-in-h-bot-4')
  })

  it('still folds the reply to an unsolicited delivery when the dispatch went to another teammate', () => {
    const items = [human(1, 'ask scribe'), dispatch(1, 'scribe'), says(3, 'Asked.'), inbound(4, 'please check the build'), says(5, 'build is green'), ...closing(6)]
    expect(keys(buildTimeline(input({ items })).lines)).toContain('x-in-h-bot-4')
  })

  it('one dispatch exempts only the answer that follows it: a later unsolicited delivery still folds', () => {
    const items = [human(1, 'ask Kevin'), dispatch(1, '@kevin'), says(3, 'Asked.'), inbound(4, 'the list'), says(5, 'Kevin sent the list.'), ...closing(6), inbound(8, 'unsolicited: build broke'), says(9, 'on it'), ...closing(10)]
    const { lines } = buildTimeline(input({ items }))
    expect(keys(lines)).not.toContain('x-in-h-bot-4')
    expect(keys(lines)).toContain('x-in-h-bot-8')
  })

  it('a second delivery from the same sender, with no new dispatch in between, folds', () => {
    const items = [human(1, 'ask Kevin'), dispatch(1, '@kevin'), says(3, 'Asked.'), inbound(4, 'part one'), says(5, 'Part one arrived.'), inbound(6, 'part two'), says(7, 'Part two arrived.'), ...closing(8)]
    const { lines } = buildTimeline(input({ items }))
    expect(keys(lines)).not.toContain('x-in-h-bot-4')
    expect(keys(lines)).toContain('x-in-h-bot-6')
  })

  it('a process notice between the dispatch and the delivery ends the scan, as a non-inbound user row does on Desktop', () => {
    const notice: ChatItem = { kind: 'notice', id: 'h-notice-4', rowId: 4, noticeKind: 'process', detail: 'raw' }
    const items = [human(1, 'ask Kevin'), dispatch(1, '@kevin'), says(3, 'Asked.'), notice, says(5, 'Noted.'), inbound(6, 'the list'), says(7, 'Kevin sent the list.'), ...closing(8)]
    expect(keys(buildTimeline(input({ items })).lines)).toContain('x-in-h-bot-6')
  })

  it('a v0.21.6 process_complete receipt between the dispatch and the delivery is a system row on Desktop: the scan goes past it', () => {
    // Desktop hydrates a process_complete row as a system notice (hydration.ts:159-175, :452), and
    // dispatchedTo skips every row that is neither user nor assistant (agent-delivery.tsx:71-73).
    const receiptRow = (displayKind?: string): ChatItem[] =>
      historyToItems([{ role: 'user', text: receiptCliCut.text, row_id: 4, ...(displayKind ? { display_kind: displayKind } : {}) }])
    const around = (receipt: ChatItem[]): ChatItem[] => [human(1, 'ask Kevin'), dispatch(1, '@kevin'), says(3, 'Asked.'), ...receipt, says(5, 'Noted.'), inbound(6, 'the list'), says(7, 'Kevin sent the list.'), ...closing(8)]

    const typed = keys(buildTimeline(input({ items: around(receiptRow('process_complete')) })).lines)
    expect(typed).not.toContain('x-in-h-bot-6')
    expect(typed).toContain('x-msg-h-bot-6')
    expect(typed).toContain('h-assistant-7')

    // The same receipt stored untyped (a row written before the upgrade) is a user row on Desktop and still ends the scan.
    expect(keys(buildTimeline(input({ items: around(receiptRow()) })).lines)).toContain('x-in-h-bot-6')
  })
})

describe('buildTimeline: consecutive merge (spec 5.4; only rows adjacent in the timeline merge)', () => {
  it('merges two sends to the same peer that end up adjacent', () => {
    const { lines } = buildTimeline(input({ items: senderItems(), rows: senderRows() }))
    const merged = lines.find(line => line.key === 'x-call_nRwha9TQ0oE9AugWq67WcB4K')
    expect(merged).toMatchObject({ kind: 'exchange', text: '4 messages with Kevin' })
    expect(keys(lines)).not.toContain('x-call_QZXUy0W80yGtyEPZwlzOFkxc')
  })

  it('sums an inbound fold and the outbound send that answers it into one row', () => {
    const at = 1789375800
    const items: ChatItem[] = [
      { kind: 'bot_message', id: 'h-bot-40', rowId: 40, handle: 'hermes', name: 'Hermes', text: 'Are you free at 18:00?', at, provenance: 'inferred' },
      { kind: 'assistant', id: 'h-assistant-41', rowId: 41, text: '', at: at + 1, reasoning: 'answer, then message back' },
      { kind: 'assistant', id: 'h-assistant-43', rowId: 43, text: 'Yes, 18:00 works.', at: at + 5 }
    ]
    const rows: TranscriptRow[] = [
      { id: 41, role: 'assistant', text: '', content: '', at: at + 1, toolCalls: [{ id: 'call_back', name: 'message_agent', args: { target: 'hermes', message: 'Yes, 18:00 works.' } }] },
      { id: 42, role: 'tool', text: '', content: '', at: at + 2, toolCallId: 'call_back', toolName: 'message_agent', result: { status: 'sent', to: '@hermes' } }
    ]
    const { lines } = buildTimeline(input({ items, rows }))
    // Same peer, nothing visible between them: one row holding all three bodies (owner request 2026-09-14).
    expect(kinds(lines, 'exchange').map(line => (line.kind === 'exchange' ? line.text : ''))).toEqual(['3 messages with Hermes'])
    expect(keys(lines)).toContain('x-in-h-bot-40')
    expect(keys(lines)).not.toContain('x-call_back')
  })

  it('does not merge across a user row', () => {
    const items = senderItems()
    const at = 1789375870
    const between: ChatItem = { kind: 'user', id: 'h-user-115', rowId: 115, text: 'and now?', at, delivery: 'acknowledged' }
    const index = items.findIndex(item => item.id === 'h-assistant-114') + 1
    const { lines } = buildTimeline(input({ items: [...items.slice(0, index), between, ...items.slice(index)], rows: senderRows() }))
    for (const key of ['x-call_nRwha9TQ0oE9AugWq67WcB4K', 'x-call_QZXUy0W80yGtyEPZwlzOFkxc']) {
      expect(lines.find(line => line.key === key)).toMatchObject({ kind: 'exchange', text: '2 messages with Kevin' })
    }
    expect(keys(lines)).toContain('x-call_QZXUy0W80yGtyEPZwlzOFkxc')
  })

  it('does not merge across another visible line', () => {
    const items = senderItems()
    const at = 1789375870
    const between: ChatItem = { kind: 'assistant', id: 'h-assistant-115', rowId: 115, text: 'One sent, one to go.', at }
    const index = items.findIndex(item => item.id === 'h-assistant-114') + 1
    const { lines } = buildTimeline(input({ items: [...items.slice(0, index), between, ...items.slice(index)], rows: senderRows() }))
    for (const key of ['x-call_nRwha9TQ0oE9AugWq67WcB4K', 'x-call_QZXUy0W80yGtyEPZwlzOFkxc']) {
      expect(lines.find(line => line.key === key)).toMatchObject({ kind: 'exchange', text: '2 messages with Kevin' })
    }
  })
})

describe('buildTimeline: notices (a short visible text by kind; the raw receipt only in the detail)', () => {
  const ITEMS: ChatItem[] = [
    { kind: 'user', id: 'h-user-9', rowId: 9, text: 'ask Kevin', at: 1789375700 },
    { kind: 'assistant', id: 'h-assistant-10', rowId: 10, text: '', at: 1789375701, reasoning: 'calling message_agent' },
    { kind: 'assistant', id: 'h-assistant-13', rowId: 13, text: 'Sent.', at: 1789375710 },
  ]

  it('renders a delivery update next to the exchange whose receipt only carried one', () => {
    const rows: TranscriptRow[] = [
      ...sendRows({ row: 10, callId: 'call_1', message: 'hi', at: 1789375701, processId: 'proc_0123456789ab' }),
      receiptRow(12, 'proc_0123456789ab', '{"delivery_id": "abc", "state": "handed off"}', 1789375705),
    ]
    const { lines } = buildTimeline(input({ items: ITEMS, rows }))
    const exchangeIndex = lines.findIndex(line => line.kind === 'exchange')
    const notice = lines[exchangeIndex + 1]
    expect(notice?.kind).toBe('notice')
    if (notice?.kind !== 'notice') return
    expect(notice.text).toBe('Delivery update')
    expect(notice.label).toBe('Delivery update')
    expect(notice.detail).toContain('[IMPORTANT:')
    expect(notice.detail).toContain('{"delivery_id": "abc", "state": "handed off"}')
  })

  it('renders an unpaired receipt as a delivery-update notice at the receipt row position', () => {
    const items = senderItems()
    const built = buildTimeline(input({ items, window: { loaded: false, oldestLoadedRowId: null, reachedStart: false, error: null } }))
    const notices = kinds(built.lines, 'notice')
    expect(notices).toHaveLength(5)
    expect(notices.every(line => line.kind === 'notice' && line.text === 'Delivery update')).toBe(true)
    expect(notices[0]?.kind === 'notice' && notices[0].detail).toContain('proc_c7ff5a9cacfb')
    expect(built.needsOlder).toBe(true)

    const index = built.lines.findIndex(line => line.key === notices[0]!.key)
    expect(built.lines[index - 1]?.key).toBe('h-assistant-90')
    expect(built.lines[index + 1]?.key).toBe('h-assistant-92')
  })

  it('places a receipt that only the REST page holds after the last older row', () => {
    const rows: TranscriptRow[] = [receiptRow(12, 'proc_0123456789ab', 'Kevin here.', 1789375705)]
    const { lines } = buildTimeline(input({ items: ITEMS, rows }))
    const index = lines.findIndex(line => line.kind === 'notice')
    expect(index).toBeGreaterThan(-1)
    expect(lines[index - 1]?.key).toBe('h-user-9')
  })

  it('names each notice kind without showing its detail', () => {
    const items: ChatItem[] = [
      { kind: 'notice', id: 'n1', rowId: 1, noticeKind: 'delivery_update', detail: '[IMPORTANT: proc_0123456789ab]' },
      { kind: 'notice', id: 'n2', rowId: 2, noticeKind: 'process', detail: 'Command: /opt/data/x' },
      { kind: 'notice', id: 'n3', rowId: 3, noticeKind: 'batch', detail: 'batch detail' },
      { kind: 'notice', id: 'n4', rowId: 4, noticeKind: 'unknown', detail: 'unknown detail' },
    ]
    const { lines } = buildTimeline(input({ items }))
    expect(texts(lines)).toEqual(['Delivery update', 'Background process update', 'Background process update', 'Notification'])
    for (const value of visibleStrings(lines)) {
      expect(value).not.toContain('[IMPORTANT:')
      expect(value).not.toContain('Command:')
    }
  })
})

describe('buildTimeline: live rows', () => {
  it('hides a live message_agent tool row that is a paired send and keeps other tools', () => {
    const items: ChatItem[] = [
      { kind: 'user', id: 'local-1', localId: 'l1', text: 'ask Kevin', at: 1789375700_000 },
      { kind: 'tool', id: 'live-tool-1', toolId: 'call_live', name: 'message_agent', args: { target: 'kevin', message: 'hi' }, result: SENT_RESULT('proc_0123456789ab'), done: true },
      { kind: 'tool', id: 'live-tool-2', toolId: 'call_other', name: 'terminal', context: 'ls /opt/data', done: false },
    ]
    const { lines } = buildTimeline(input({ items }))
    expect(keys(lines)).not.toContain('live-tool-1')
    const tool = lines.find(line => line.key === 'live-tool-2')
    expect(tool).toMatchObject({ kind: 'tool', label: 'Using terminal…' })
    // the live send still produced an exchange, placed where its tool row was
    const exchange = lines.find(line => line.kind === 'exchange')
    expect(exchange?.kind).toBe('exchange')
    expect(lines.findIndex(line => line.key === exchange?.key)).toBeLessThan(lines.findIndex(line => line.key === 'live-tool-2'))
  })

  it('appends the streaming or working line, and the state line when the window failed', () => {
    const working = buildTimeline(input({ live: { ...IDLE, streaming: true, statusLine: 'reading the roster' } }))
    expect(working.lines.at(-1)).toEqual({ key: 'working', kind: 'working', text: 'Hermes: reading the roster' })

    const streaming = buildTimeline(input({ live: { ...IDLE, streaming: true, assistantText: 'partial' } }))
    expect(streaming.lines.at(-1)).toEqual({ key: 'stream', kind: 'stream' })

    const failed = buildTimeline(input({ items: senderItems(), window: { loaded: false, oldestLoadedRowId: null, reachedStart: false, error: 'offline' } }))
    expect(failed.lines.at(-1)).toEqual({ key: 'state', kind: 'state', text: 'Message details could not be loaded' })

    const both = buildTimeline(input({ live: { ...IDLE, streaming: true }, window: { loaded: false, oldestLoadedRowId: null, reachedStart: false, error: 'offline' } }))
    expect(both.lines.map(line => line.kind)).toEqual(['working', 'state'])

    const fine = buildTimeline(input({ items: senderItems(), rows: senderRows() }))
    expect(kinds(fine.lines, 'state')).toHaveLength(0)
  })
})

describe('workingLineText', () => {
  it('uses the status line when there is one', () => {
    expect(workingLineText('Hermes', 'reading the roster')).toBe('Hermes: reading the roster')
    expect(workingLineText('Hermes', null)).toBe('Hermes is working')
    expect(workingLineText('Hermes', '')).toBe('Hermes is working')
  })
})

describe('hasActivity', () => {
  it('is false for a plain conversation and true for anything Activity can show', () => {
    const plain: ChatItem[] = [
      { kind: 'user', id: 'u1', rowId: 1, text: 'hi', at: 1789375700 },
      { kind: 'assistant', id: 'a1', rowId: 2, text: 'hello', at: 1789375701 },
    ]
    expect(buildTimeline(input({ items: plain })).hasActivity).toBe(false)
    expect(buildTimeline(input({ items: plain, live: { ...IDLE, reasoningText: 'thinking' } })).hasActivity).toBe(true)
    expect(buildTimeline(input({ items: [...plain, { kind: 'tool', id: 't1', name: 'terminal', done: true }] })).hasActivity).toBe(true)
    expect(buildTimeline(input({ items: [...plain, { kind: 'approval', id: 'ap1', requestId: 'r', payload: {} as never, state: 'pending' }] })).hasActivity).toBe(true)
    expect(buildTimeline(input({ items: [{ ...plain[1]!, reasoning: 'because' } as ChatItem] })).hasActivity).toBe(true)
  })
})

describe('activityEntries', () => {
  const entries = () => activityEntries(input({ items: senderItems(), rows: senderRows() }))

  it('lists reasoning collapsed, tools, and one entry per exchange with its evidence', () => {
    const all = entries()
    const reasoning = all.filter(entry => entry.kind === 'reasoning')
    expect(reasoning.length).toBeGreaterThan(0)
    expect(reasoning.every(entry => entry.title === 'Reasoning' && entry.collapsed)).toBe(true)
    expect(reasoning[0]?.detail.length).toBeGreaterThan(0)

    const tools = all.filter(entry => entry.kind === 'tool')
    expect(tools.map(entry => entry.title)).toContain('Used skill_view')

    const exchanges = all.filter(entry => entry.kind === 'exchange')
    expect(exchanges).toHaveLength(10)
    expect(exchanges[0]?.title).toBe('2 messages with Kevin')
    expect(exchanges[0]?.detail).toBe('delivery: settled · worker: exited 0 · reply: text · provenance: structured · process: proc_c7ff5a9cacfb')
  })

  it('keeps timeline order and reports the refusal evidence', () => {
    const all = entries()
    const refusal = all.find(entry => entry.kind === 'exchange' && entry.title === 'Delivery outcome unknown')
    expect(refusal?.detail).toContain('reason: unknown')
    expect(refusal?.detail).toContain('error: No teammate named')

    const titles = all.map(entry => entry.title)
    expect(titles.indexOf('2 messages with Kevin')).toBeLessThan(titles.indexOf('Delivery outcome unknown'))
    expect(new Set(all.map(entry => entry.id)).size).toBe(all.length)
  })

  it('adds a notice entry with its detail and the live reasoning', () => {
    const rows: TranscriptRow[] = [
      ...sendRows({ row: 10, callId: 'call_1', message: 'hi', at: 1789375701, processId: 'proc_0123456789ab' }),
      receiptRow(12, 'proc_0123456789ab', '{"delivery_id": "abc", "state": "handed off"}', 1789375705),
    ]
    const items: ChatItem[] = [{ kind: 'assistant', id: 'h-assistant-10', rowId: 10, text: '', at: 1789375701, reasoning: 'calling message_agent' }]
    const all = activityEntries(input({ items, rows, live: { ...IDLE, streaming: true, reasoningText: 'still thinking' } }))
    const notice = all.find(entry => entry.kind === 'notice')
    expect(notice?.title).toBe('Delivery update')
    expect(notice?.detail).toContain('[IMPORTANT:')
    expect(all.filter(entry => entry.kind === 'reasoning').map(entry => entry.detail)).toEqual(['calling message_agent', 'still thinking'])
  })
})

describe('exchangeTranscript', () => {
  const built = () => buildTimeline(input({ items: senderItems(), rows: senderRows() }))

  it('lists every body with Kevin oldest first and marks the anchored send', () => {
    const result = built()
    const { entries, anchorKey } = exchangeTranscript(result, { peerKey: 'local:kevin', anchor: { rowId: 102 } })

    const messages = entries.filter(entry => entry.kind === 'message')
    expect(messages).toHaveLength(15)
    // five sends (self first), Kevin's three answers to this bot's own dispatches (one body each, spec 13)
    // and the one inbound turn that folds (Kevin first), in timeline order
    expect(messages.map(entry => (entry.kind === 'message' ? (entry.author === 'self' ? 'self' : entry.author.display.name) : ''))).toEqual([
      'self', 'Kevin', 'self', 'Kevin', 'Kevin', 'self', 'Kevin', 'Kevin',
      'self', 'Kevin', 'self', 'Kevin', 'Kevin', 'Kevin', 'self',
    ])
    expect(messages[0]?.kind === 'message' && messages[0].text).toContain('Please let the owner know')

    expect(anchorKey).toBe('x-call_B0fvHiZUchl0fdsEWOqZbJfA-sent')
    expect(entries.find(entry => entry.key === anchorKey)).toMatchObject({ anchored: true })
    expect(entries.filter(entry => entry.kind === 'message' && entry.anchored)).toHaveLength(1)
  })

  it('inserts a time separator only where the gap exceeds TIME_GAP_S', () => {
    const result = built()
    const { entries } = exchangeTranscript(result, { peerKey: 'local:kevin' })
    const times = entries.filter(entry => entry.kind === 'time')
    expect(TIME_GAP_S).toBe(1800)
    expect(times).toHaveLength(1)

    const index = entries.findIndex(entry => entry.kind === 'time')
    const next = entries[index + 1]
    expect(next?.key).toBe('x-call_W7BH7HW4zAEwvNbj4kNYzWUh-sent')
    const at = next?.kind === 'message' ? next.at! : 0
    const label = times[0]?.kind === 'time' ? times[0].label : ''
    expect(label).toContain(formatClock(at))
  })

  it('spells the date out when the gap crosses a day, and carries the state copy when no reply came', () => {
    const day = 24 * 60 * 60
    const first = 1789200000
    const rows: TranscriptRow[] = [
      ...sendRows({ row: 10, callId: 'call_1', message: 'first', at: first, processId: 'proc_0123456789ab' }),
      receiptRow(12, 'proc_0123456789ab', 'Kevin here.', first + 5),
      ...sendRows({ row: 13, callId: 'call_2', message: 'second', at: first + day, processId: 'proc_bbbbbbbbbbbb' }),
    ]
    const result = buildTimeline(input({ rows, now: (first + day + 60) * 1000 }))
    const { entries } = exchangeTranscript(result, { peerKey: 'local:kevin' })

    const time = entries.find(entry => entry.kind === 'time')
    expect(time?.kind === 'time' && time.label).toBe(`${formatDateSeparator(first + day)} ${formatClock(first + day)}`)

    const last = entries.at(-1)
    expect(last).toMatchObject({ kind: 'message', text: 'second', stateText: 'Messaged Kevin' })
    expect(entries.filter(entry => entry.kind === 'message' && entry.stateText !== undefined)).toHaveLength(1)
  })

  it('returns nothing for a peer with no exchanges', () => {
    expect(exchangeTranscript(built(), { peerKey: 'local:nobody' })).toEqual({ entries: [] })
  })

  it('reads an inbound exchange from the peer', () => {
    const result = buildTimeline(input({ items: receiverItems() }))
    const { entries } = exchangeTranscript(result, { peerKey: 'local:default' })
    const messages = entries.filter(entry => entry.kind === 'message')
    expect(messages).toHaveLength(7)
    expect(messages[0]?.kind === 'message' && messages[0].author !== 'self' && messages[0].author.display.name).toBe('Hermes')
    expect(messages[1]?.kind === 'message' && messages[1].author).toBe('self')
  })
})

describe('completion evidence (spec 12.3)', () => {
  const bot = (id: number, text: string): ChatItem => ({ kind: 'bot_message', id: `h-bot-${id}`, rowId: id, handle: 'hermes', name: 'hermes', text, at: id, provenance: 'inferred' })
  const answer = (id: number, text: string, over: Partial<Extract<ChatItem, { kind: 'assistant' }>> = {}): ChatItem => ({ kind: 'assistant', id: `h-assistant-${id}`, rowId: id, text, at: id, ...over })
  const liveAnswer = (text: string, over: Partial<Extract<ChatItem, { kind: 'assistant' }>> = {}): ChatItem => ({ kind: 'assistant', id: 'live-assistant-9', text, at: 900, ...over })
  const exchangeLine = (lines: Line[], key: string) => lines.find(line => line.key === key && line.kind === 'exchange')
  const activityDetail = (items: ChatItem[], id: string, over: Partial<TimelineInput> = {}) => activityEntries(input({ items, ...over })).find(entry => entry.id === `activity-exchange-${id}`)?.detail ?? ''

  it('folds an earlier historical clean turn with the inferred-from-history note', () => {
    const items = [bot(11, 'hi'), answer(12, 'hello'), bot(13, 'again'), answer(14, 'sure')]
    const { lines } = buildTimeline(input({ items, idleConfirmed: false }))
    expect(exchangeLine(lines, 'x-in-h-bot-11')).toBeDefined()
    expect(keys(lines)).toContain('h-bot-13')
    expect(activityDetail(items, 'x-in-h-bot-11', { idleConfirmed: false })).toContain('completion inferred from history')
  })

  it('folds the last turn only under a confirmed idle snapshot, with the inferred-from-idle note', () => {
    const items = [bot(11, 'hi'), answer(12, 'hello')]
    expect(exchangeLine(buildTimeline(input({ items, idleConfirmed: false })).lines, 'x-in-h-bot-11')).toBeUndefined()
    const folded = buildTimeline(input({ items, idleConfirmed: true }))
    expect(exchangeLine(folded.lines, 'x-in-h-bot-11')).toBeDefined()
    expect(activityDetail(items, 'x-in-h-bot-11')).toContain('completion inferred from idle')
  })

  it('folds a turn whose answer carries a completed outcome, and never one that failed or is unknown', () => {
    const completed = [bot(11, 'hi'), answer(12, 'hello', { turnOutcome: 'completed' })]
    expect(exchangeLine(buildTimeline(input({ items: completed, idleConfirmed: false })).lines, 'x-in-h-bot-11')).toBeDefined()
    expect(activityDetail(completed, 'x-in-h-bot-11', { idleConfirmed: false })).toContain('completion confirmed')
    for (const outcome of ['failed', 'unknown'] as const) {
      const items = [bot(11, 'hi'), answer(12, 'hello', { turnOutcome: outcome }), bot(13, 'later'), answer(14, 'ok', { turnOutcome: 'completed' })]
      const { lines } = buildTimeline(input({ items }))
      expect(exchangeLine(lines, 'x-in-h-bot-11')).toBeUndefined()
      expect(keys(lines)).toContain('h-assistant-12')
    }
  })

  it('a live answer without a row id never folds and stays expanded until reconciliation', () => {
    const items = [bot(11, 'hi'), answer(12, 'hello'), liveAnswer('sure', { turnOutcome: 'completed', liveAnchor: { afterRowId: 12 } })]
    const { lines } = buildTimeline(input({ items }))
    expect(exchangeLine(lines, 'x-in-h-bot-11')).toBeUndefined()
    expect(keys(lines)).toContain('live-assistant-9')
    expect(keys(lines)).toContain('h-bot-11')
  })

  it('a live turn without message.complete stays expanded', () => {
    const items = [bot(11, 'hi'), answer(12, 'hello'), bot(13, 'again')]
    const { lines } = buildTimeline(input({ items, live: { ...IDLE, streaming: true }, idleConfirmed: false }))
    expect(keys(lines)).toContain('h-bot-13')
    expect(exchangeLine(lines, 'x-in-h-bot-11')).toBeDefined()
  })

  it('an ambiguous reconciliation keeps the live outcome and marks the candidate durable turns unknown and expanded', () => {
    const items = [bot(11, 'hi'), answer(12, 'hello'), bot(13, 'again'), answer(14, 'sure'), bot(15, 'and'), answer(16, 'yes'), liveAnswer('sure', { turnOutcome: 'completed', liveAnchor: { afterRowId: 12 } })]
    const { lines } = buildTimeline(input({ items }))
    expect(exchangeLine(lines, 'x-in-h-bot-11')).toBeDefined()
    expect(exchangeLine(lines, 'x-in-h-bot-13')).toBeUndefined()
    expect(exchangeLine(lines, 'x-in-h-bot-15')).toBeUndefined()
    expect(keys(lines)).toEqual(expect.arrayContaining(['h-bot-13', 'h-assistant-14', 'h-bot-15', 'h-assistant-16', 'live-assistant-9']))
  })

  it('a retained live answer with nothing newer marks the turn that holds it, not the ones before', () => {
    const items = [bot(11, 'hi'), answer(12, 'hello'), bot(13, 'again'), answer(14, 'sure'), liveAnswer('sure', { turnOutcome: 'completed', liveAnchor: { afterRowId: 14 } })]
    const { lines } = buildTimeline(input({ items }))
    expect(exchangeLine(lines, 'x-in-h-bot-11')).toBeDefined()
    expect(exchangeLine(lines, 'x-in-h-bot-13')).toBeUndefined()
  })

  it('a turn newer than the retained bound folds while the bounded candidates stay expanded', () => {
    // The snapshot that first retained the live answer ended at row 14:
    // only turns whose head lies in (12, 14] can be its home. The later turn folds normally.
    const items = [bot(11, 'hi'), answer(12, 'hello'), bot(13, 'again'), answer(14, 'sure'), bot(17, 'more'), answer(18, 'yes'), bot(19, 'and now'), liveAnswer('sure', { turnOutcome: 'completed', liveAnchor: { afterRowId: 12, retainedBeforeRowId: 14 } })]
    const { lines } = buildTimeline(input({ items }))
    // the bounded candidate stays expanded
    expect(exchangeLine(lines, 'x-in-h-bot-13')).toBeUndefined()
    expect(keys(lines)).toEqual(expect.arrayContaining(['h-bot-13', 'h-assistant-14', 'live-assistant-9']))
    // the turn that started after the bound is not suspect and folds on inference from history
    expect(exchangeLine(lines, 'x-in-h-bot-17')).toBeDefined()
    expect(exchangeLine(lines, 'x-in-h-bot-11')).toBeDefined()
  })

  it('a local live answer explained by the human send it followed does not disturb earlier folds', () => {
    const items: ChatItem[] = [bot(11, 'hi'), answer(12, 'hello'), { kind: 'user', id: 'local-l1', text: 'Ping', at: 800, delivery: 'acknowledged' }, liveAnswer('Pong', { turnOutcome: 'completed', liveAnchor: { afterRowId: 12, userItemId: 'local-l1' } })]
    const { lines } = buildTimeline(input({ items, idleConfirmed: false }))
    expect(exchangeLine(lines, 'x-in-h-bot-11')).toBeDefined()
    expect(activityDetail(items, 'x-in-h-bot-11', { idleConfirmed: false })).toContain('completion inferred from history')
  })

  it('a retained live answer anchored before every row suspends folding of every durable turn', () => {
    const items = [bot(11, 'hi'), answer(12, 'hello'), bot(13, 'again'), answer(14, 'sure'), liveAnswer('sure', { turnOutcome: 'completed', liveAnchor: { afterRowId: null } })]
    const { lines } = buildTimeline(input({ items }))
    expect(exchangeLine(lines, 'x-in-h-bot-11')).toBeUndefined()
    expect(exchangeLine(lines, 'x-in-h-bot-13')).toBeUndefined()
    expect(keys(lines)).toEqual(expect.arrayContaining(['h-bot-11', 'h-assistant-12', 'h-bot-13', 'h-assistant-14', 'live-assistant-9']))
  })

  it('a notice following an active turn does not make it historical', () => {
    const items: ChatItem[] = [bot(11, 'hi'), answer(12, 'hello'), { kind: 'notice', id: 'live-notice-1', noticeKind: 'process', detail: 'background update', at: 900, live: true }]
    const open = buildTimeline(input({ items, idleConfirmed: false }))
    expect(exchangeLine(open.lines, 'x-in-h-bot-11')).toBeUndefined()
    expect(keys(open.lines)).toContain('h-bot-11')
    // with a confirmed snapshot the same turn folds on idle evidence
    expect(exchangeLine(buildTimeline(input({ items, idleConfirmed: true })).lines, 'x-in-h-bot-11')).toBeDefined()
  })

  it('a receipt following an active turn does not make it historical', () => {
    const receipt = parseReceiptRow(receiptText('proc_000000000abc', '{"status":"settled","delivery_id":"d1","reply":"ok"}'))
    if (receipt.kind !== 'receipts') throw new Error('fixture')
    const items: ChatItem[] = [bot(11, 'hi'), answer(12, 'hello'), { kind: 'receipt', id: 'live-receipt-proc_000000000abc', receipt: receipt.receipts[0]!, at: 900, live: true }]
    const { lines } = buildTimeline(input({ items, idleConfirmed: false }))
    expect(exchangeLine(lines, 'x-in-h-bot-11')).toBeUndefined()
    expect(keys(lines)).toContain('h-bot-11')
    // with a confirmed snapshot the same turn folds on idle evidence
    expect(exchangeLine(buildTimeline(input({ items, idleConfirmed: true })).lines, 'x-in-h-bot-11')).toBeDefined()
  })

  it('a later receipt-headed turn with a confirmed completed answer proves the last conversation turn historical', () => {
    const receiptParsed = parseReceiptRow(receiptText('proc_000000000abc', '{"status":"settled","delivery_id":"d1","reply":"ok"}'))
    if (receiptParsed.kind !== 'receipts') throw new Error('fixture')
    const receiptItem: ChatItem = { kind: 'receipt', id: 'h-receipt-87', rowId: 87, receipt: receiptParsed.receipts[0]!, at: 87, live: false }
    const items: ChatItem[] = [bot(85, 'hi'), answer(86, 'hello'), receiptItem, answer(88, 'ok', { turnOutcome: 'completed' })]
    const { lines } = buildTimeline(input({ items, idleConfirmed: false }))
    expect(exchangeLine(lines, 'x-in-h-bot-85')).toBeDefined()
    expect(activityDetail(items, 'x-in-h-bot-85', { idleConfirmed: false })).toContain('completion inferred from history')
  })

  it('a later input row alone, without a confirmed completed answer, does not make the last conversation turn historical', () => {
    const receiptParsed = parseReceiptRow(receiptText('proc_000000000abc', '{"status":"settled","delivery_id":"d1","reply":"ok"}'))
    if (receiptParsed.kind !== 'receipts') throw new Error('fixture')
    const receiptItem: ChatItem = { kind: 'receipt', id: 'h-receipt-87', rowId: 87, receipt: receiptParsed.receipts[0]!, at: 87, live: false }
    const items: ChatItem[] = [bot(85, 'hi'), answer(86, 'hello'), receiptItem, answer(88, 'ok')]
    const { lines } = buildTimeline(input({ items, idleConfirmed: false }))
    expect(exchangeLine(lines, 'x-in-h-bot-85')).toBeUndefined()
  })

  it('a later confirmed completion never folds a turn whose own answer failed', () => {
    const receiptParsed = parseReceiptRow(receiptText('proc_000000000abc', '{"status":"settled","delivery_id":"d1","reply":"ok"}'))
    if (receiptParsed.kind !== 'receipts') throw new Error('fixture')
    const receiptItem: ChatItem = { kind: 'receipt', id: 'h-receipt-87', rowId: 87, receipt: receiptParsed.receipts[0]!, at: 87, live: false }
    const items: ChatItem[] = [bot(85, 'hi'), answer(86, 'hello', { turnOutcome: 'failed' }), receiptItem, answer(88, 'ok', { turnOutcome: 'completed' })]
    const { lines } = buildTimeline(input({ items, idleConfirmed: false }))
    expect(exchangeLine(lines, 'x-in-h-bot-85')).toBeUndefined()
  })
})

describe('new-activity marker (spec 12.1)', () => {
  const sendItems = (): ChatItem[] => senderItems()
  const rows = () => senderRows()
  const line = (lines: Line[], key: string) => { const found = lines.find(l => l.key === key); if (found?.kind !== 'exchange') throw new Error(`no exchange ${key}`); return found }

  it('marks a row with any unacknowledged member identity and says so in the label', () => {
    const { lines } = buildTimeline(input({ items: sendItems(), rows: rows(), acknowledged: [] }))
    const marked = line(lines, 'x-call_Nfx9qJkrcOBUSpNkVll8VCEm')
    expect(marked.marked).toBe(true)
    expect(marked.label).toBe('New activity. 2 messages with Kevin. Opens the messages with Kevin')
  })

  it('clears the marker once every member identity is acknowledged', () => {
    const first = buildTimeline(input({ items: sendItems(), rows: rows() }))
    const acknowledged = first.exchanges.flatMap(x => x.identities)
    const { lines } = buildTimeline(input({ items: sendItems(), rows: rows(), acknowledged }))
    expect(kinds(lines, 'exchange').every(l => l.kind === 'exchange' && !l.marked)).toBe(true)
    expect(line(lines, 'x-call_Nfx9qJkrcOBUSpNkVll8VCEm').label).toBe('2 messages with Kevin. Opens the messages with Kevin')
  })

  it('a merged row is marked when one member is unacknowledged, and a new outcome re-marks an acknowledged send', () => {
    const first = buildTimeline(input({ items: sendItems(), rows: rows() }))
    const merged = first.lines.find(l => l.kind === 'exchange' && l.exchange.group !== undefined)
    if (merged?.kind !== 'exchange') throw new Error('no merged row')
    const members = merged.exchange.identities
    const allButOne = first.exchanges.flatMap(x => x.identities).filter(id => id !== members[members.length - 1])
    expect(line(buildTimeline(input({ items: sendItems(), rows: rows(), acknowledged: allButOne })).lines, merged.key).marked).toBe(true)

    const sendingItems: ChatItem[] = [{ kind: 'tool', id: 'live-tool-1', toolId: 'call_live', name: 'message_agent', args: { target: 'kevin', message: 'hi' }, done: false }]
    const sending = buildTimeline(input({ items: sendingItems })).exchanges[0]!
    const settledItems: ChatItem[] = [{ ...sendingItems[0]!, done: true, result: { status: 'sent', process_id: 'proc_live00000001' } } as ChatItem]
    const settled = buildTimeline(input({ items: settledItems, acknowledged: sending.identities })).lines.find(l => l.kind === 'exchange')
    expect(settled).toMatchObject({ kind: 'exchange', marked: true })
  })

  it('an inbound fold is marked through its answer identity', () => {
    const { lines } = buildTimeline(input({ items: receiverItems() }))
    expect(line(lines, 'x-in-h-bot-11').marked).toBe(true)
    const acknowledged = ['answer:12', 'answer:18', 'inbound:19']
    expect(line(buildTimeline(input({ items: receiverItems(), acknowledged })).lines, 'x-in-h-bot-11').marked).toBe(false)
  })
})

describe('transcript identities and reveal (spec 12.1 acknowledgement)', () => {
  const result = () => buildTimeline(input({ items: senderItems(), rows: senderRows() }))
  // The fixture's Kevin peer key: 'profile:kevin' does not match `peerKey(exchange.peer)` for this
  // fixture (it resolves to a local roster key), so the key is read from the fixture itself.
  const kevinKey = () => peerKey(result().exchanges[0]!.peer)

  it('puts the send and outcome identities on the sent entry and the return on the reply entry', () => {
    const { entries } = exchangeTranscript(result(), { peerKey: kevinKey() })
    const sent = entries.find(e => e.kind === 'message' && e.key === 'x-call_W7BH7HW4zAEwvNbj4kNYzWUh-sent')
    const reply = entries.find(e => e.kind === 'message' && e.key === 'x-call_W7BH7HW4zAEwvNbj4kNYzWUh-reply')
    expect(sent).toMatchObject({ identities: ['send:call_W7BH7HW4zAEwvNbj4kNYzWUh', expect.stringMatching(/^outcome:call_W7BH7HW4zAEwvNbj4kNYzWUh:settled:settled:text:false$/)] })
    expect(reply).toMatchObject({ identities: ['return:proc_782bd84d7f2a'] })
    expect(identitiesOf(entries)).toEqual(result().exchanges.filter(x => peerKey(x.peer) === kevinKey()).flatMap(x => x.identities))
  })

  it('unpresentedOlder returns only the entries before the earliest presented one, never arrivals after it', () => {
    const { entries } = exchangeTranscript(result(), { peerKey: kevinKey() })
    const keysOf = (list: TranscriptEntry[]) => list.map(e => e.key)
    const presented = new Set(keysOf(entries.slice(3, 6)))
    expect(keysOf(unpresentedOlder(entries, presented))).toEqual(keysOf(entries.slice(0, 3)))
    expect(unpresentedOlder(entries, new Set())).toEqual([])
    expect(unpresentedOlder(entries, new Set(keysOf(entries)))).toEqual([])

    // The one acknowledgement decision (spec 12.1), pure: open acknowledges what is on screen,
    // a reveal acknowledges what it exposed, an arrival while mounted acknowledges nothing.
    expect(acknowledgementBatch(entries, new Set(), { opening: true, revealPending: false })).toEqual(entries)
    expect(keysOf(acknowledgementBatch(entries, presented, { opening: false, revealPending: true }))).toEqual(keysOf(entries.slice(0, 3)))
    expect(acknowledgementBatch(entries, presented, { opening: false, revealPending: false })).toEqual([])
    expect(acknowledgementBatch(entries, new Set(keysOf(entries)), { opening: false, revealPending: true })).toEqual([])

    // A screen opened with zero entries (opening true, entries []) still acknowledges everything
    // (the empty batch): the opening flag, not `presented.size`, decides. And once mounted, a
    // reveal against an empty `presented` set (never opened, or opened with no entries) yields no
    // acknowledgement even though entries have since arrived — an arrival while mounted is never
    // acknowledged (spec 12.1).
    expect(acknowledgementBatch(entries, new Set(), { opening: false, revealPending: true })).toEqual([])
  })
})

describe('read-only labels (spec 12.2)', () => {
  // The fixture peer keys ('profile:kevin' / 'profile:default') don't match `peerKey(exchange.peer)`
  // for these fixtures (they resolve to local roster keys), so the keys are read from the fixtures.
  const kevinKey = () => peerKey(buildTimeline(input({ items: senderItems(), rows: senderRows() })).exchanges[0]!.peer)
  const hermesKey = () => peerKey(buildTimeline(input({ items: receiverItems() })).exchanges[0]!.peer)

  it('labels every entry by provenance, in the visible text and in the accessibility label', () => {
    const outbound = exchangeTranscript(buildTimeline(input({ items: senderItems(), rows: senderRows() })), { peerKey: kevinKey() }).entries
    const cli = outbound.filter(e => e.kind === 'message' && e.exchangeId === 'x-call_W7BH7HW4zAEwvNbj4kNYzWUh')
    expect(cli.map(e => (e.kind === 'message' ? [e.role, e.roleLabel, e.label.startsWith(`${e.roleLabel}: `)] : []))).toEqual([
      ['sent', 'Sent to Kevin', true],
      ['returned', 'Returned automatically', true],
    ])

    const inbound = exchangeTranscript(buildTimeline(input({ items: receiverItems() })), { peerKey: hermesKey() }).entries
    const first = inbound.filter(e => e.kind === 'message' && e.exchangeId === 'x-in-h-bot-11')
    expect(first.map(e => (e.kind === 'message' ? [e.role, e.roleLabel] : []))).toEqual([
      ['inbound', 'Message from Hermes'],
      ['answer', 'Answer in this turn'],
    ])
    // no entry claims delivery to the peer
    for (const entry of [...outbound, ...inbound]) {
      if (entry.kind === 'message') expect(entry.roleLabel).not.toMatch(/delivered|Messaged/)
    }
  })

  it('a peer with an empty display name and no handle still yields a non-blank label', () => {
    const items: ChatItem[] = [
      { kind: 'bot_message', id: 'h-bot-11', rowId: 11, handle: '', name: '', text: 'hi', at: 11, provenance: 'inferred' },
      { kind: 'assistant', id: 'h-assistant-12', rowId: 12, text: 'hello', at: 12 },
      { kind: 'bot_message', id: 'h-bot-13', rowId: 13, handle: '', name: '', text: 'again', at: 13, provenance: 'inferred' }
    ]
    const result = buildTimeline(input({ items }))
    const entries = exchangeTranscript(result, { peerKey: peerKey(result.exchanges[0]!.peer) }).entries
    const labels = entries.flatMap(e => (e.kind === 'message' ? [e.roleLabel] : []))
    expect(labels).toContain('Message from an unknown teammate')
    for (const label of labels) expect(label.trim()).not.toBe('')
  })
})
