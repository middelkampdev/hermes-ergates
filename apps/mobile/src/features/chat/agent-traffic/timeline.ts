/**
 * The one presentation policy: the only producer of visible lines, working-line text,
 * accessibility labels, Activity entries and the read-only transcript. Raw receipt, notice
 * or tool-argument text never reaches a line or a label (docs/04). Pure: no React or React
 * Native imports (ADR-029 rule 1).
 */

import { formatClock, formatDateSeparator } from '@/lib/time'

import { hasText, isInputRow, type ChatItem } from '../history'
import type { LiveTurn } from '../session-reducer'

import { buildExchanges, collectEvidence, exchangeCopy, exchangeIdentities, isOpenable, mergeConsecutive, peerName, type Completion, type Evidence, type Exchange, type WindowBounds } from './exchange'
import { peerKey, resolveHandle } from './peers'
import type { PeerRef, RosterPeer, TranscriptRow } from './types'

// ---------------------------------------------------------------------------
// Contracts
// ---------------------------------------------------------------------------

export type Line =
  | { key: string; kind: 'date'; label: string }
  | { key: string; kind: 'item'; item: Exclude<ChatItem, { kind: 'bot_message' | 'receipt' | 'notice' | 'tool' }> }
  | { key: string; kind: 'tool'; item: Extract<ChatItem, { kind: 'tool' }>; label: string }
  | { key: string; kind: 'bot_message'; item: Extract<ChatItem, { kind: 'bot_message' }>; peer: PeerRef; label: string }
  | { key: string; kind: 'exchange'; exchange: Exchange; text: string; label: string; openable: boolean; marked: boolean }
  | { key: string; kind: 'notice'; text: string; label: string; detail: string }
  | { key: string; kind: 'state'; text: string }
  | { key: string; kind: 'stream' }
  | { key: string; kind: 'working'; text: string }

export interface TimelineInput {
  items: ChatItem[]
  rows: TranscriptRow[]
  window: WindowBounds & { error: string | null }
  roster: RosterPeer[]
  registeredPeers?: string[]
  selfProfile: string
  selfName: string
  live: LiveTurn
  inflightError: string | null
  /** Spec 12.3: the session reported itself idle and nothing has happened since. */
  idleConfirmed: boolean
  /** Exchange identities this device has already acknowledged (ADR-028); read in a later task. */
  acknowledged: string[]
  now?: number
}

export interface TimelineResult {
  /** Oldest first; the screen reverses for its inverted list. */
  lines: Line[]
  /** Every exchange the timeline holds, in timeline order and never merged, so the transcript keeps all bodies. */
  exchanges: Exchange[]
  needsOlder: boolean
  hasActivity: boolean
}

export interface ActivityEntry {
  id: string
  kind: 'reasoning' | 'notice' | 'exchange' | 'tool'
  title: string
  detail: string
  collapsed: boolean
}

export type TranscriptEntry =
  | { key: string; kind: 'message'; author: 'self' | PeerRef; role: 'sent' | 'returned' | 'inbound' | 'answer'; roleLabel: string; label: string; text: string; at?: number; exchangeId: string; anchored: boolean; stateText?: string; identities: string[] }
  | { key: string; kind: 'time'; label: string }

/** Spec 12.2: the send is "Sent to <peer>", a return "Returned automatically", the inbound message "Message from <peer>", the local answer "Answer in this turn". No entry claims delivery. */
function roleLabelFor(role: 'sent' | 'returned' | 'inbound' | 'answer', peer: PeerRef): string {
  // One fallback for the whole feature: a peer with neither a name nor a handle is still named.
  const name = peerName(peer)
  switch (role) {
    case 'sent': return `Sent to ${name}`
    case 'returned': return 'Returned automatically'
    case 'inbound': return `Message from ${name}`
    case 'answer': return 'Answer in this turn'
  }
}

export const TIME_GAP_S = 30 * 60
const NEW_ACTIVITY = 'New activity'

const WINDOW_ERROR_TEXT = 'Message details could not be loaded'
const DELIVERY_UPDATE = 'Delivery update'
const MESSAGE_AGENT = 'message_agent'

// ---------------------------------------------------------------------------
// Small readings of one item
// ---------------------------------------------------------------------------

/** History timestamps are Unix seconds, live ones milliseconds; every reading here is in seconds. */
function atSeconds(at: number | undefined): number | undefined {
  if (at === undefined) return undefined
  return at > 1e12 ? at / 1000 : at
}

function rowIdOf(item: ChatItem): number | undefined {
  return (item as { rowId?: number }).rowId
}

/** The timestamps a date separator may be keyed on (spec 5.9 grouping, as the chat screen does today). */
function dateAt(item: ChatItem): number | undefined {
  switch (item.kind) {
    case 'user':
    case 'assistant':
    case 'event':
    case 'bot_message':
      return item.at
    default:
      return undefined
  }
}

/** Tool labels carry the name only: arguments and context are Activity detail (docs/04). */
function toolLabel(item: Extract<ChatItem, { kind: 'tool' }>): string {
  return item.done ? `Used ${item.name}` : `Using ${item.name}…`
}

function noticeText(kind: Extract<ChatItem, { kind: 'notice' }>['noticeKind']): string {
  if (kind === 'delivery_update') return DELIVERY_UPDATE
  if (kind === 'process' || kind === 'batch') return 'Background process update'
  return 'Notification'
}

export function workingLineText(name: string, statusLine: string | null): string {
  return statusLine ? `${name}: ${statusLine}` : `${name} is working`
}

// ---------------------------------------------------------------------------
// Receiver-side collapse (spec 5.7)
// ---------------------------------------------------------------------------

interface Turn {
  start: number
  /** Exclusive. */
  end: number
}

/** An input row of any kind starts a turn; everything until the next one belongs to it. */
function groupTurns(items: ChatItem[]): Turn[] {
  const turns: Turn[] = []
  for (const [index, item] of items.entries()) {
    if (isInputRow(item) || turns.length === 0) {
      if (turns.length > 0) turns[turns.length - 1]!.end = index
      turns.push({ start: index, end: items.length })
    }
  }
  return turns
}

interface Folded {
  exchange: Exchange
  /** Items the exchange row stands for; the bot message itself is replaced, not dropped. */
  hidden: string[]
}

interface RetainedAnchor {
  /** The newest durable row id known when the live turn started; `null` when none was. */
  afterRowId: number | null
  /** The newest row id of the snapshot that first retained the answer; `undefined` when unbounded. */
  beforeRowId: number | undefined
  /** The turn that holds the retained answer — the fallback candidate. */
  turnIndex: number
  /**
   * Whether any turn's head falls in the candidate range. Computed once per retained answer, so the
   * per-turn check in `mayCorrespondToRetained` does not scan every turn head again for each turn.
   */
  anyCandidate: boolean
}

/** Is a turn head a candidate home for a retained answer: inside `(afterRowId, beforeRowId]`? */
function inCandidateRange(head: number | undefined, live: { afterRowId: number | null; beforeRowId: number | undefined }): boolean {
  if (head === undefined) return live.afterRowId === null && live.beforeRowId === undefined
  if (live.afterRowId !== null && head <= live.afterRowId) return false
  return live.beforeRowId === undefined || head <= live.beforeRowId
}

/**
 * Live sealed answers no durable row explains yet (spec 12.3 fallback). Each keeps the durable turns
 * that could be its home expanded until a reconciliation places it; one that follows the human's own
 * local send in its turn is explained by that send and retains nothing.
 */
function retainedLiveAnchors(items: ChatItem[], turns: Turn[]): RetainedAnchor[] {
  const retained: RetainedAnchor[] = []
  const heads = turns.map(turn => rowIdOf(items[turn.start]!))
  for (const [turnIndex, turn] of turns.entries()) {
    let explained = false
    for (let i = turn.start; i < turn.end; i += 1) {
      const item = items[i]!
      // A live input row inside the same turn is the durable-free explanation for what follows it.
      if (isInputRow(item) && rowIdOf(item) === undefined) explained = true
      if (item.kind === 'assistant' && item.rowId === undefined && item.turnOutcome !== undefined && item.liveAnchor !== undefined && !explained) {
        const bounds = { afterRowId: item.liveAnchor.afterRowId, beforeRowId: item.liveAnchor.retainedBeforeRowId }
        retained.push({ ...bounds, turnIndex, anyCandidate: heads.some(head => inCandidateRange(head, bounds)) })
      }
    }
  }
  return retained
}

/**
 * Could a durable turn be the home of a retained live answer? Then it is unknown and stays expanded.
 *
 * The candidates are bounded on both sides by row ids, never by position: a turn older than the
 * live turn's start cannot hold its answer, and neither can one that began after the snapshot that
 * first retained it. When no turn falls in the range, the turn that holds the retained item is the
 * only candidate.
 */
function mayCorrespondToRetained(items: ChatItem[], turns: Turn[], index: number, retained: RetainedAnchor[]): boolean {
  const head = rowIdOf(items[turns[index]!.start]!)
  return retained.some(live => (live.anyCandidate ? inCandidateRange(head, live) : live.turnIndex === index))
}

/** `@Dr. Foo`, `scribe@laptop`, `peer/scribe` → `dr. foo` / `scribe`: the routing alias a `message_agent` target and a "Message from" signature share (Desktop `agentKey`). */
function agentKey(value: unknown): string {
  return typeof value === 'string' ? value.trim().replace(/^@/, '').replace(/@[^@]*$/, '').split('/').pop()!.toLowerCase() : ''
}

/**
 * Rows Desktop shows as system rows, which `dispatchedTo` scans past: events, and on v0.21.6 the
 * receipt or notice of a `process_complete` row (apps/desktop/src/lib/chat-messages/hydration.ts:159-175,
 * :452). An untyped receipt row, written before v0.21.6, is a user row on Desktop and ends the scan.
 */
function isSystemRow(item: ChatItem): boolean {
  if (item.kind === 'event') return true
  return (item.kind === 'receipt' || item.kind === 'notice') && item.displayKind !== undefined
}

/**
 * Did this bot send a `message_agent` to the sender of the inbound row at `index`, in the current
 * exchange? Then that row is the teammate's answer to our dispatch, and the assistant row after it
 * is the report to the human, not a reply to the teammate: the turn must not fold. Hermes Desktop
 * `dispatchedTo` (apps/desktop/src/components/assistant-ui/thread/agent-delivery.tsx:48-83 at
 * v0.21.6, #114629), rule for rule: the scan goes backward and ends at the nearest input row that is
 * not an inbound row, or at an earlier inbound row from the same sender, so one dispatch exempts only
 * the answer that follows it. The sender matches by handle or by display name: a missed fold shows
 * content, a wrong fold hides it.
 */
function answersOwnDispatch(items: ChatItem[], index: number): boolean {
  const head = items[index]
  if (head?.kind !== 'bot_message') return false
  const sender = new Set([agentKey(head.handle), agentKey(head.name)].filter(Boolean))

  for (let i = index - 1; i >= 0; i -= 1) {
    const item = items[i]!
    if (item.kind === 'bot_message') {
      if (sender.has(agentKey(item.handle)) || sender.has(agentKey(item.name))) return false
      continue
    }
    // Desktop scans past a system row (agent-delivery.tsx:71-73); every other input row ends the exchange.
    if (!isSystemRow(item) && isInputRow(item)) return false
    if (item.kind === 'tool' && item.name === MESSAGE_AGENT && sender.has(agentKey(item.args?.target))) return true
  }
  return false
}

/**
 * Spec 13: the teammate's answer to this bot's own dispatch. Only the inbound row becomes a compact
 * "Message from <peer>" row (Desktop's note); the turn's answer is the report to the human and stays
 * a bubble. A live row without a row id has no durable identity yet and stays a bubble (spec 12.1).
 */
function messageOnlyFold(head: Extract<ChatItem, { kind: 'bot_message' }>, roster: RosterPeer[]): Folded | undefined {
  if (head.rowId === undefined) return undefined
  const exchange: Exchange = {
    kind: 'exchange',
    id: `x-msg-${head.id}`,
    direction: 'inbound',
    anchor: { rowId: head.rowId },
    peer: resolveHandle(head.handle, roster, head.name),
    sent: head.at !== undefined ? { text: head.text, at: head.at } : { text: head.text },
    state: { delivery: 'settled', worker: { kind: 'not_observed' }, reply: { kind: 'none' }, latestOutcomeUnavailable: false },
    phase: 'settled',
    pairing: 'paired',
    members: [head.id],
    identities: [`inbound:${head.rowId}`],
    evidence: { provenance: head.provenance },
    bodies: 1,
    notice: false,
  }
  return { exchange, hidden: [] }
}

interface FoldOptions { roster: RosterPeer[]; isLast: boolean; idleConfirmed: boolean; streaming: boolean; suspect: boolean }

/**
 * Spec 5.7: the answer is the last assistant row with text inside the turn; no tool row may follow it,
 * and the turn may hold no card and no errored row.
 *
 * Spec 12.3 decides whether the turn is over, on four rules:
 *  1. a live answer (no row id) has no durable identity until reconciliation and never folds;
 *  2. a `failed` or `unknown` outcome never folds, and neither does a turn that may hold a retained
 *     live answer — that turn is itself unknown;
 *  3. a `completed` outcome is confirmed evidence, whatever else is going on;
 *  4. otherwise a turn that is not the last one folds on inference from history, and the last one
 *     folds only under a confirmed idle snapshot with nothing streaming.
 */
function foldTurn(items: ChatItem[], turn: Turn, opts: FoldOptions): Folded | undefined {
  const head = items[turn.start]
  if (head?.kind !== 'bot_message') return undefined
  // The inbound row answers a dispatch of this bot: what follows is the report to the human.
  if (answersOwnDispatch(items, turn.start)) return messageOnlyFold(head, opts.roster)

  const body = items.slice(turn.start + 1, turn.end)
  if (body.some(item => item.kind === 'clarify' || item.kind === 'approval')) return undefined
  if (body.some(item => item.kind === 'assistant' && item.error !== undefined)) return undefined

  let answerIndex = -1
  for (const [index, item] of body.entries()) {
    if (hasText(item)) answerIndex = index
  }
  const answer = answerIndex === -1 ? undefined : body[answerIndex]
  if (answer === undefined || answer.kind !== 'assistant') return undefined
  if (body.slice(answerIndex + 1).some(item => item.kind === 'tool')) return undefined
  // Spec 12.1: a live answer has no durable identity until reconciliation; it never folds.
  if (answer.rowId === undefined) return undefined
  // Spec 12.3: failed and unknown never fold.
  if (answer.turnOutcome === 'failed' || answer.turnOutcome === 'unknown') return undefined

  let completion: Completion
  if (answer.turnOutcome === 'completed') completion = 'confirmed'
  else if (opts.suspect) return undefined
  else if (!opts.isLast) completion = 'inferred_history'
  else if (opts.idleConfirmed && !opts.streaming) completion = 'inferred_idle'
  else return undefined

  const peer = resolveHandle(head.handle, opts.roster, head.name)
  const anchor = head.rowId !== undefined ? { rowId: head.rowId } : {}
  const state: Exchange['state'] = { delivery: 'settled', worker: { kind: 'not_observed' }, reply: { kind: 'text', body: answer.text, completeness: 'complete' }, latestOutcomeUnavailable: false }
  const evidence: Exchange['evidence'] = { provenance: head.provenance, completion }
  const exchange: Exchange = {
    kind: 'exchange',
    id: `x-in-${head.id}`,
    direction: 'inbound',
    anchor,
    peer,
    sent: head.at !== undefined ? { text: head.text, at: head.at } : { text: head.text },
    reply: answer.at !== undefined ? { body: answer.text, at: answer.at } : { body: answer.text },
    state,
    phase: 'settled',
    pairing: 'paired',
    members: [head.id, answer.id],
    identities: exchangeIdentities({ anchor, direction: 'inbound', phase: 'settled', state, evidence, answerRowId: answer.rowId }),
    evidence,
    bodies: 2,
    notice: false,
  }

  // The whole turn folds into the row: the answer, the reasoning-only rows and the tool rows go with it
  // (their reasoning and tools still reach Activity).
  const hidden = [answer.id, ...body.filter(item => item.kind === 'tool' || (item.kind === 'assistant' && !hasText(item))).map(item => item.id)]
  return { exchange, hidden }
}

/** Spec 12.3, last paragraph: the session's last turn is the last one a user, bot message or event started. */
function lastConversationTurn(items: ChatItem[], turns: Turn[]): number {
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const kind = items[turns[i]!.start]!.kind
    if (kind === 'user' || kind === 'bot_message' || kind === 'event') return i
  }
  return turns.length - 1
}

/**
 * Spec 12.3 rule (i): the backend runs a session's turns serially, so a later turn of any head
 * kind (receipt, notice, user, bot message, event) whose answer row carries a confirmed `completed`
 * outcome proves every earlier turn ended, including the last conversation turn. A later input row
 * alone, with no confirmed completed answer, proves nothing.
 */
function hasConfirmedCompletionAfter(items: ChatItem[], turns: Turn[], last: number): boolean {
  for (let index = last + 1; index < turns.length; index += 1) {
    const turn = turns[index]!
    const body = items.slice(turn.start + 1, turn.end)
    let answerIndex = -1
    for (const [bodyIndex, item] of body.entries()) {
      if (hasText(item)) answerIndex = bodyIndex
    }
    const answer = answerIndex === -1 ? undefined : body[answerIndex]
    if (answer?.kind === 'assistant' && answer.rowId !== undefined && answer.turnOutcome === 'completed') return true
  }
  return false
}

function foldTurns(items: ChatItem[], input: TimelineInput): Map<number, Folded> {
  const turns = groupTurns(items)
  const folded = new Map<number, Folded>()
  const retained = retainedLiveAnchors(items, turns)
  const last = lastConversationTurn(items, turns)
  const idleConfirmed = input.idleConfirmed && !input.inflightError
  const lastProvenHistorical = hasConfirmedCompletionAfter(items, turns, last)
  for (const [index, turn] of turns.entries()) {
    // A receipt or a notice after the last conversation turn is not a turn of its own.
    if (index > last) continue
    const fold = foldTurn(items, turn, {
      roster: input.roster,
      isLast: index === last && !lastProvenHistorical,
      idleConfirmed,
      streaming: input.live.streaming,
      suspect: mayCorrespondToRetained(items, turns, index, retained)
    })
    if (fold) folded.set(turn.start, fold)
  }
  return folded
}

// ---------------------------------------------------------------------------
// Placement (spec 5.5 anchor). An exchange or receipt sits behind its own row, found by row id,
// or behind the newest older row when its own is not loaded, never by list position; a live-only
// send sits at its tool row.
// ---------------------------------------------------------------------------

/** The index of the item an exchange or a receipt sits behind; -1 means "before every item". */
function indexForRow(items: ChatItem[], rowId: number): number {
  const exact = items.findIndex(item => rowIdOf(item) === rowId)
  if (exact !== -1) return exact

  let last = -1
  for (const [index, item] of items.entries()) {
    const id = rowIdOf(item)
    if (id !== undefined && id < rowId) last = index
  }
  return last
}

function placeExchanges(items: ChatItem[], exchanges: Exchange[]): Map<number, Exchange[]> {
  const placed = new Map<number, Exchange[]>()
  for (const exchange of exchanges) {
    let index: number
    if (exchange.anchor.rowId !== undefined) {
      index = indexForRow(items, exchange.anchor.rowId)
    } else {
      // A live-only send: it belongs where its tool row is; if that row is gone, it is the newest thing we hold.
      const toolCallId = exchange.anchor.toolCallId
      const live = items.findIndex(item => item.kind === 'tool' && item.toolId !== undefined && item.toolId === toolCallId)
      index = live === -1 ? items.length - 1 : live
    }
    const at = placed.get(index) ?? []
    at.push(exchange)
    placed.set(index, at)
  }
  return placed
}

interface PlacedReceipt {
  key: string
  detail: string
}

/**
 * Unpaired and not-loaded receipts render as a notice, in place of their row (spec 5.5): with no
 * send to fold into, the notice is the only place their delivery update shows.
 */
function placeUnpairedReceipts(items: ChatItem[], build: ReturnType<typeof buildExchanges>): Map<number, PlacedReceipt[]> {
  const placed = new Map<number, PlacedReceipt[]>()
  for (const receipt of build.unpaired) {
    const ids = receipt.itemIds ?? (receipt.itemId !== undefined ? [receipt.itemId] : [])
    let index = items.findIndex(item => ids.includes(item.id))
    if (index === -1) index = receipt.rowId !== undefined ? indexForRow(items, receipt.rowId) : items.length - 1
    const at = placed.get(index) ?? []
    at.push({ key: `notice-${receipt.processId}`, detail: receipt.receipt.raw })
    placed.set(index, at)
  }
  return placed
}

/**
 * Items an exchange already speaks for, plus the rows that are never rendered at all: a receipt item
 * (folded into its exchange or drawn as a notice) and a `message_agent` tool row without an id,
 * which can never be paired.
 */
function hiddenItemIds(items: ChatItem[], members: Set<string>, folded: Map<number, Folded>): Set<string> {
  const hidden = new Set<string>()
  for (const item of items) {
    if (item.kind === 'receipt') hidden.add(item.id)
    if (item.kind !== 'tool' || item.name !== MESSAGE_AGENT) continue
    // Socket history carries no tool ids: the REST row is the durable representation of that send.
    if (item.toolId === undefined || members.has(item.id)) hidden.add(item.id)
  }
  for (const fold of folded.values()) {
    for (const id of fold.hidden) hidden.add(id)
  }
  return hidden
}

// ---------------------------------------------------------------------------
// Activity detail (spec 6, docs/04: details live here and nowhere else)
// ---------------------------------------------------------------------------

/** What the Activity detail says a fold rests on (spec 12.3). */
const COMPLETION_NOTE: Record<Completion, string> = {
  confirmed: 'completion confirmed',
  inferred_history: 'completion inferred from history',
  inferred_idle: 'completion inferred from idle'
}

function workerText(exchange: Exchange): string {
  const worker = exchange.state.worker
  return worker.kind === 'exited' ? `exited ${worker.code}` : worker.kind
}

function exchangeDetail(exchange: Exchange): string {
  const { evidence, state } = exchange
  const parts = [`delivery: ${state.delivery}`, `worker: ${workerText(exchange)}`, `reply: ${state.reply.kind}`, `provenance: ${evidence.provenance ?? 'receipt'}`]
  if (evidence.reason !== undefined) parts.push(`reason: ${evidence.reason}`)
  if (evidence.error !== undefined) parts.push(`error: ${evidence.error}`)
  if (evidence.deliveryId !== undefined) parts.push(`delivery id: ${evidence.deliveryId}`)
  if (evidence.processId !== undefined) parts.push(`process: ${evidence.processId}`)
  if (state.latestOutcomeUnavailable) parts.push('latest outcome unavailable')
  if (evidence.completion !== undefined) parts.push(COMPLETION_NOTE[evidence.completion])
  return parts.join(' · ')
}

function toolDetail(item: Extract<ChatItem, { kind: 'tool' }>): string {
  if (item.context) return item.context
  if (item.args && Object.keys(item.args).length > 0) return JSON.stringify(item.args)
  return ''
}

// ---------------------------------------------------------------------------
// buildTimeline
// ---------------------------------------------------------------------------

interface Assembled {
  result: TimelineResult
  activity: ActivityEntry[]
}

function assemble(input: TimelineInput): Assembled {
  const { items, live } = input
  const now = input.now === undefined ? new Date() : new Date(input.now)

  const evidence: Evidence = collectEvidence(items, input.rows)
  const registered = input.registeredPeers === undefined ? { roster: input.roster, window: input.window } : { roster: input.roster, registeredPeers: input.registeredPeers, window: input.window }
  const build = buildExchanges(evidence, registered)

  const folded = foldTurns(items, input)
  /** Every chat item an exchange already stands for: its live tool rows and its receipts. */
  const memberIds = new Set(build.exchanges.flatMap(exchange => exchange.members))
  const hidden = hiddenItemIds(items, memberIds, folded)
  const placed = placeExchanges(items, build.exchanges)
  const receipts = placeUnpairedReceipts(items, build)
  const receiptRaw = new Map(evidence.receipts.map(receipt => [receipt.processId, receipt.receipt.raw]))
  const acknowledged = new Set(input.acknowledged)

  const lines: Line[] = []
  const activity: ActivityEntry[] = []
  const exchanges: Exchange[] = []
  let lastDay = ''
  /** The exchange line a following exchange may merge into; cleared by any other line and by any input row. */
  let mergeInto: { index: number; exchange: Exchange } | null = null

  const pushLine = (line: Line): void => {
    lines.push(line)
    if (line.kind === 'notice') activity.push({ id: `activity-${line.key}`, kind: 'notice', title: line.text, detail: line.detail, collapsed: false })
    if (line.kind !== 'exchange') mergeInto = null
  }

  const pushDate = (at: number | undefined, key: string): void => {
    const seconds = atSeconds(at)
    if (seconds === undefined) return
    const label = formatDateSeparator(seconds, now)
    if (label === lastDay) return
    lastDay = label
    pushLine({ key: `date-${label}-${key}`, kind: 'date', label })
  }

  const exchangeLine = (exchange: Exchange): Line => {
    const text = exchangeCopy(exchange)
    const openable = isOpenable(exchange)
    const marked = exchange.identities.some(id => !acknowledged.has(id))
    const base = openable ? `${text}. Opens the messages with ${exchange.peer.display.name}` : text
    return { key: exchange.id, kind: 'exchange', exchange, text, openable, marked, label: marked ? `${NEW_ACTIVITY}. ${base}` : base }
  }

  const pushNotice = (key: string, text: string, detail: string): void => {
    pushLine({ key, kind: 'notice', text, label: text, detail })
  }

  const pushExchange = (exchange: Exchange): void => {
    exchanges.push(exchange)
    activity.push({ id: `activity-exchange-${exchange.id}`, kind: 'exchange', title: exchangeCopy(exchange), detail: exchangeDetail(exchange), collapsed: false })

    const previous = mergeInto
    // Same peer and nothing visible in between: the rows sum up into one "N messages with <peer>" row,
    // whatever their direction; an input row that was folded into an exchange draws no line and so
    // does not break the run (owner request 2026-09-14; before it, only exchanges of the same
    // direction merged).
    if (previous !== null && peerKey(previous.exchange.peer) === peerKey(exchange.peer)) {
      const merged = mergeConsecutive(previous.exchange, exchange)
      lines[previous.index] = exchangeLine(merged)
      mergeInto = { index: previous.index, exchange: merged }
    } else {
      pushDate(exchange.sent.at, exchange.id)
      pushLine(exchangeLine(exchange))
      mergeInto = { index: lines.length - 1, exchange }
    }

    // A paired receipt that only carried a delivery update draws its notice right after the exchange
    // row, so the update reads beside the send it is about.
    if (exchange.notice) {
      const processId = exchange.evidence.processId
      pushNotice(`notice-${exchange.id}`, DELIVERY_UPDATE, (processId !== undefined ? receiptRaw.get(processId) : undefined) ?? '')
    }
  }

  const pushItem = (item: ChatItem): void => {
    switch (item.kind) {
      case 'receipt':
        return
      case 'tool':
        pushLine({ key: item.id, kind: 'tool', item, label: toolLabel(item) })
        return
      case 'bot_message': {
        const peer = resolveHandle(item.handle, input.roster, item.name)
        pushDate(item.at, item.id)
        pushLine({ key: item.id, kind: 'bot_message', item, peer, label: `${peer.display.name}: ${item.text}` })
        return
      }
      case 'notice':
        pushNotice(item.id, noticeText(item.noticeKind), item.detail)
        return
      case 'assistant':
        // A reasoning-only turn draws no bubble; Activity lists its reasoning (spec 5.9).
        if (!hasText(item)) return
        pushDate(item.at, item.id)
        pushLine({ key: item.id, kind: 'item', item })
        return
      default:
        pushDate(dateAt(item), item.id)
        pushLine({ key: item.id, kind: 'item', item })
    }
  }

  for (const exchange of placed.get(-1) ?? []) pushExchange(exchange)
  for (const receipt of receipts.get(-1) ?? []) pushNotice(receipt.key, DELIVERY_UPDATE, receipt.detail)

  for (const [index, item] of items.entries()) {
    if (item.kind === 'assistant' && item.reasoning) {
      activity.push({ id: `activity-reasoning-${item.id}`, kind: 'reasoning', title: 'Reasoning', detail: item.reasoning, collapsed: true })
    }
    if (item.kind === 'tool' && !memberIds.has(item.id)) {
      activity.push({ id: `activity-tool-${item.id}`, kind: 'tool', title: toolLabel(item), detail: toolDetail(item), collapsed: false })
    }

    // A visible line of any kind (pushLine) ends a merge run; a folded input row draws no line and does not.
    if (isInputRow(item) && !hidden.has(item.id) && folded.get(index) === undefined) mergeInto = null

    const fold = folded.get(index)
    if (fold !== undefined) pushExchange(fold.exchange)
    else if (!hidden.has(item.id)) pushItem(item)

    for (const receipt of receipts.get(index) ?? []) pushNotice(receipt.key, DELIVERY_UPDATE, receipt.detail)
    for (const exchange of placed.get(index) ?? []) pushExchange(exchange)
  }

  if (live.reasoningText.trim()) {
    activity.push({ id: 'activity-reasoning-live', kind: 'reasoning', title: 'Reasoning', detail: live.reasoningText, collapsed: true })
  }
  if (live.streaming) {
    pushLine(live.assistantText ? { key: 'stream', kind: 'stream' } : { key: 'working', kind: 'working', text: workingLineText(input.selfName, live.statusLine) })
  }
  if (input.window.error && !input.window.loaded) {
    pushLine({ key: 'state', kind: 'state', text: WINDOW_ERROR_TEXT })
  }

  const hasCard = items.some(item => (item.kind === 'clarify' || item.kind === 'approval') && item.state === 'pending')
  const hasReasoning = items.some(item => item.kind === 'assistant' && item.reasoning !== undefined) || live.reasoningText.trim().length > 0
  const hasActivity = hasCard || hasReasoning || lines.some(line => line.kind === 'tool' || line.kind === 'notice' || line.kind === 'exchange')

  return { result: { lines, exchanges, needsOlder: build.needsOlder, hasActivity }, activity }
}

/**
 * The lines and the Activity entries are two views of ONE assembly. A screen
 * that needs both calls this once: `buildTimeline` + `activityEntries` would
 * walk the whole chat twice on every streamed token, and two walks can only
 * ever agree by accident.
 */
export function assembleTimeline(input: TimelineInput): { timeline: TimelineResult; activity: ActivityEntry[] } {
  const { result, activity } = assemble(input)
  return { timeline: result, activity }
}

export function buildTimeline(input: TimelineInput): TimelineResult {
  return assemble(input).result
}

export function activityEntries(input: TimelineInput): ActivityEntry[] {
  return assemble(input).activity
}

// ---------------------------------------------------------------------------
// Read-only transcript (spec 6)
// ---------------------------------------------------------------------------

function matchesAnchor(exchange: Exchange, anchor: { rowId?: number; toolCallId?: string } | undefined): boolean {
  if (anchor === undefined) return false
  if (anchor.rowId !== undefined && exchange.anchor.rowId === anchor.rowId) return true
  return anchor.toolCallId !== undefined && exchange.anchor.toolCallId === anchor.toolCallId
}

function timeLabel(at: number, previous: number): string {
  const sameDay = new Date(at * 1000).toDateString() === new Date(previous * 1000).toDateString()
  return sameDay ? formatClock(at) : `${formatDateSeparator(at)} ${formatClock(at)}`
}

/**
 * Every body the app holds with one peer, oldest first, with a time separator at gaps over 30 minutes
 * and the anchored send marked so the screen can scroll to it (spec 6).
 */
export function exchangeTranscript(result: TimelineResult, opts: { peerKey: string; anchor?: { rowId?: number; toolCallId?: string } }): { entries: TranscriptEntry[]; anchorKey?: string } {
  const entries: TranscriptEntry[] = []
  let anchorKey: string | undefined
  let previousAt: number | undefined

  const pushMessage = (entry: Extract<TranscriptEntry, { kind: 'message' }>): void => {
    const at = entry.at
    if (at !== undefined && previousAt !== undefined && at - previousAt > TIME_GAP_S) {
      entries.push({ key: `time-${entry.key}`, kind: 'time', label: timeLabel(at, previousAt) })
    }
    entries.push(entry)
    if (at !== undefined) previousAt = at
  }

  for (const exchange of result.exchanges) {
    if (peerKey(exchange.peer) !== opts.peerKey) continue
    const outbound = exchange.direction === 'outbound'
    const anchored = matchesAnchor(exchange, opts.anchor)
    const sentKey = `${exchange.id}-sent`
    if (anchored && anchorKey === undefined) anchorKey = sentKey

    // The identities split between the two bubbles the entry pair presents, so each is acknowledged
    // exactly when its own body is on screen. A send with no reply yet has no second bubble: its
    // first entry is the only thing that will ever present this exchange, so it carries EVERY
    // identity (including the outcome), or the row's state copy could never be acknowledged.
    const returns = exchange.identities.filter(id => id.startsWith('return:') || id.startsWith('answer:'))
    const sends = exchange.identities.filter(id => !returns.includes(id))

    const sentRole = outbound ? 'sent' : 'inbound'
    const sentRoleLabel = roleLabelFor(sentRole, exchange.peer)
    const sent: Extract<TranscriptEntry, { kind: 'message' }> = {
      key: sentKey,
      kind: 'message',
      author: outbound ? 'self' : exchange.peer,
      role: sentRole,
      roleLabel: sentRoleLabel,
      label: `${sentRoleLabel}: ${exchange.sent.text}`,
      text: exchange.sent.text,
      exchangeId: exchange.id,
      anchored,
      identities: exchange.reply === undefined ? exchange.identities : sends
    }
    const sentAt = atSeconds(exchange.sent.at)
    if (sentAt !== undefined) sent.at = sentAt
    // No reply body to show: the row's own copy says what is known instead (spec 5.4).
    if (exchange.reply === undefined && outbound) sent.stateText = exchangeCopy(exchange)
    pushMessage(sent)

    if (exchange.reply === undefined) continue
    const replyRole = outbound ? 'returned' : 'answer'
    const replyRoleLabel = roleLabelFor(replyRole, exchange.peer)
    const reply: Extract<TranscriptEntry, { kind: 'message' }> = {
      key: `${exchange.id}-reply`,
      kind: 'message',
      author: outbound ? exchange.peer : 'self',
      role: replyRole,
      roleLabel: replyRoleLabel,
      label: `${replyRoleLabel}: ${exchange.reply.body}`,
      text: exchange.reply.body,
      exchangeId: exchange.id,
      anchored: false,
      identities: returns
    }
    const replyAt = atSeconds(exchange.reply.at)
    if (replyAt !== undefined) reply.at = replyAt
    pushMessage(reply)
  }

  return anchorKey === undefined ? { entries } : { entries, anchorKey }
}

/** Every identity the given entries present (spec 12.1: acknowledged exactly when presented). */
export function identitiesOf(entries: TranscriptEntry[]): string[] {
  return entries.flatMap(entry => (entry.kind === 'message' ? entry.identities : []))
}

/**
 * The one acknowledgement decision (spec 12.1), pure so the hook around it only wires state:
 * the opening presentation acknowledges everything on screen (even zero entries — a screen opened
 * empty that later pages in arrivals must not acknowledge them), a pending reveal
 * acknowledges exactly what it exposed, and anything else — an arrival while the screen stays
 * mounted — acknowledges nothing.
 */
export function acknowledgementBatch(
  entries: TranscriptEntry[],
  presented: ReadonlySet<string>,
  options: { opening: boolean; revealPending: boolean }
): TranscriptEntry[] {
  if (options.opening) return entries
  if (!options.revealPending) return []
  return unpresentedOlder(entries, presented)
}

/**
 * The entries a reveal exposed: those before the earliest entry already presented. Arrivals while the
 * screen is mounted append after the latest entry, so they are never returned (spec 12.1).
 */
export function unpresentedOlder(entries: TranscriptEntry[], presented: ReadonlySet<string>): TranscriptEntry[] {
  const first = entries.findIndex(entry => presented.has(entry.key))
  return first <= 0 ? [] : entries.slice(0, first)
}
