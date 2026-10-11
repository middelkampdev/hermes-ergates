/**
 * Exchange evidence, pairing, state, copy and the transcript-window rule.
 * Pure: no React or React Native imports (ADR-029 rule 1).
 */

import type { ChatItem } from '../history'

import { classifyUserRow } from './classify'
import { deliveryFromReason, deliveryFromStatus, readBody, workerFromHeadline, type ParsedReceipt } from './receipt'
import { resolveTarget } from './peers'
import type { Delivery, ExchangeState, PeerRef, Reply, RosterPeer, TranscriptRow, Worker } from './types'

const MESSAGE_AGENT = 'message_agent'

// ---------------------------------------------------------------------------
// Evidence (spec 5.5: the three id-bearing facts an exchange is built from)
// ---------------------------------------------------------------------------

export interface SendEvidence {
  toolCallId: string
  anchorRowId?: number
  target: string
  message: string
  at?: number
  liveItemId?: string
  done: boolean
}

export interface ResultEvidence {
  toolCallId: string
  result: unknown
  rowId?: number
  liveItemId?: string
}

export interface ReceiptEvidence {
  processId: string
  receipt: ParsedReceipt
  rowId?: number
  at?: number
  itemId?: string
  /**
   * Every chat-item id that stands for this receipt. The same completion can reach the app live,
   * through socket history and through the REST page; only some of those ids are reconstructable
   * from the process id, so the whole set is carried here and folded into `members`.
   */
  itemIds?: string[]
  live: boolean
}

export interface Evidence {
  sends: SendEvidence[]
  results: ResultEvidence[]
  receipts: ReceiptEvidence[]
}

/** What the app currently holds of the REST transcript (spec 5.5). */
export interface WindowBounds {
  loaded: boolean
  oldestLoadedRowId: number | null
  reachedStart: boolean
}

/** One exchange's own phase, state and held bodies, kept per member when rows merge (spec 12.4). */
export interface MemberState {
  phase: Exchange['phase']
  state: ExchangeState
  bodies: number
}

export type Completion = 'confirmed' | 'inferred_history' | 'inferred_idle'

export interface Exchange {
  kind: 'exchange'
  id: string
  direction: 'outbound' | 'inbound'
  anchor: { rowId?: number; toolCallId?: string }
  peer: PeerRef
  sent: { text: string; at?: number }
  reply?: { body: string; at?: number }
  state: ExchangeState
  phase: 'sending' | 'settled'
  pairing: 'paired' | 'not_loaded'
  members: string[]
  /** Stable activity identities this row stands for (spec 12.1); a merged row carries every member's. */
  identities: string[]
  evidence: { status?: string; reason?: string; error?: string; deliveryId?: string; processId?: string; provenance?: 'structured' | 'inferred'; completion?: Completion }
  /** Bodies the app holds (sent + reply); drives the "N messages" copy. */
  bodies: number
  /** The paired receipt carried a delivery update, not an outcome: the timeline renders a notice beside this row. */
  notice: boolean
  /** Set by `mergeConsecutive`: how many exchanges this row stands for, and each member's own state (spec 12.4). */
  group?: { count: number; states: MemberState[] }
}

export interface ExchangeBuild {
  exchanges: Exchange[]
  unpaired: (ReceiptEvidence & { pairing: 'unpaired' | 'not_loaded' })[]
  needsOlder: boolean
}

// ---------------------------------------------------------------------------
// collectEvidence
// ---------------------------------------------------------------------------

function stringArg(args: Record<string, unknown> | undefined, key: string): string {
  const value = args?.[key]
  return value === undefined || value === null ? '' : String(value)
}

/** REST assistant rows: every `message_agent` tool call is one send, anchored on its row (spec 5.5). */
function sendsFromRows(rows: TranscriptRow[]): SendEvidence[] {
  const sends: SendEvidence[] = []
  for (const row of rows) {
    for (const call of row.toolCalls ?? []) {
      if (call.name !== MESSAGE_AGENT) continue
      const send: SendEvidence = { toolCallId: call.id, anchorRowId: row.id, target: stringArg(call.args, 'target'), message: stringArg(call.args, 'message'), done: true }
      if (row.at !== undefined) send.at = row.at
      sends.push(send)
    }
  }
  return sends
}

/** Live `message_agent` tool items: the same send, before its REST row exists. */
function sendsFromItems(items: ChatItem[]): SendEvidence[] {
  const sends: SendEvidence[] = []
  for (const item of items) {
    if (item.kind !== 'tool' || item.toolId === undefined || item.name !== MESSAGE_AGENT) continue
    sends.push({ toolCallId: item.toolId, target: stringArg(item.args, 'target'), message: stringArg(item.args, 'message'), liveItemId: item.id, done: item.done })
  }
  return sends
}

/**
 * REST wins on every field except `done`: the REST row of an assistant turn exists as soon as the
 * turn is recorded, so its send always reads `done: true`, while the live tool item is the only
 * evidence of a send still in flight. A send is done when BOTH say so — otherwise the second send of
 * a two-send turn would read as settled with no result ("Delivery outcome unknown") until its tail
 * lands. A live item only contributes the item id the timeline folds away.
 */
function mergeSends(rest: SendEvidence[], live: SendEvidence[]): SendEvidence[] {
  const byId = new Map<string, SendEvidence>()
  for (const send of rest) byId.set(send.toolCallId, send)
  for (const send of live) {
    const existing = byId.get(send.toolCallId)
    if (!existing) {
      byId.set(send.toolCallId, send)
      continue
    }
    existing.done = existing.done && send.done
    if (send.liveItemId !== undefined) existing.liveItemId = send.liveItemId
  }
  return [...byId.values()]
}

/**
 * A REST tool row is result evidence when it is a `message_agent` result, or when its id matches a
 * send we already hold (a row whose `tool_name` did not survive). A `message_agent` result without a
 * send is the "tool row without its assistant row" the window rule pages backward for.
 */
function resultsFromRows(rows: TranscriptRow[], sendIds: Set<string>): ResultEvidence[] {
  const results: ResultEvidence[] = []
  for (const row of rows) {
    if (row.toolCallId === undefined) continue
    if (row.toolName !== MESSAGE_AGENT && !sendIds.has(row.toolCallId)) continue
    results.push({ toolCallId: row.toolCallId, result: row.result, rowId: row.id })
  }
  return results
}

function resultsFromItems(items: ChatItem[]): ResultEvidence[] {
  const results: ResultEvidence[] = []
  for (const item of items) {
    if (item.kind !== 'tool' || item.toolId === undefined || item.name !== MESSAGE_AGENT) continue
    if (!item.done || item.result === undefined) continue
    results.push({ toolCallId: item.toolId, result: item.result, liveItemId: item.id })
  }
  return results
}

/** Receipt chat items: one per parsed `[IMPORTANT: Background process …]` row, live or from socket history. */
function receiptsFromItems(items: ChatItem[]): ReceiptEvidence[] {
  const receipts: ReceiptEvidence[] = []
  for (const item of items) {
    if (item.kind !== 'receipt') continue
    const evidence: ReceiptEvidence = { processId: item.receipt.headline.processId, receipt: item.receipt, itemId: item.id, itemIds: [item.id], live: item.live }
    if (item.rowId !== undefined) evidence.rowId = item.rowId
    if (item.at !== undefined) evidence.at = item.at
    receipts.push(evidence)
  }
  return receipts
}

/** REST user rows that parse as receipts (spec 5.2); a batch row yields one entry per receipt. */
function receiptsFromRows(rows: TranscriptRow[]): ReceiptEvidence[] {
  const receipts: ReceiptEvidence[] = []
  for (const row of rows) {
    if (row.role !== 'user') continue
    // The full 5.1 evidence order, exactly as `window.ts` and the timeline classify the same row: a
    // stamped row is a bot message, never receipt text, however its body happens to read.
    const classified = classifyUserRow({ text: row.text, displayKind: row.displayKind, displayMetadata: row.displayMetadata })
    if (classified.kind !== 'receipts') continue
    for (const receipt of classified.receipts) {
      const processId = receipt.headline.processId
      const itemId = `h-receipt-${row.id}-${processId}`
      const evidence: ReceiptEvidence = { processId, receipt, rowId: row.id, itemId, itemIds: [itemId], live: false }
      if (row.at !== undefined) evidence.at = row.at
      receipts.push(evidence)
    }
  }
  return receipts
}

/**
 * Receipts dedupe by process id: the same completion can arrive live (`status.update`), through
 * socket history and through the REST page. The durable row wins the fields, but every duplicate's
 * item id survives in `itemIds` — a socket-history receipt on a row without a `row_id` is called
 * `h-receipt-i<index>-<processId>` and cannot be reconstructed from the process id, so dropping it
 * would leave that item unfolded beside the exchange.
 */
function mergeReceipts(rest: ReceiptEvidence[], live: ReceiptEvidence[]): ReceiptEvidence[] {
  const byProcess = new Map<string, ReceiptEvidence>()
  for (const receipt of [...rest, ...live]) {
    const existing = byProcess.get(receipt.processId)
    if (existing === undefined) {
      byProcess.set(receipt.processId, receipt)
      continue
    }
    const winner = existing.rowId === undefined && receipt.rowId !== undefined ? receipt : existing
    const loser = winner === existing ? receipt : existing
    winner.itemIds = uniqueMembers([...(winner.itemIds ?? []), winner.itemId, ...(loser.itemIds ?? []), loser.itemId])
    byProcess.set(receipt.processId, winner)
  }
  return [...byProcess.values()]
}

/** Gathers every id-bearing fact about outbound `message_agent` traffic from the live items and the REST page. */
export function collectEvidence(items: ChatItem[], rows: TranscriptRow[]): Evidence {
  const sends = mergeSends(sendsFromRows(rows), sendsFromItems(items))
  const sendIds = new Set(sends.map(send => send.toolCallId))

  const restResults = resultsFromRows(rows, sendIds)
  const resultIds = new Set(restResults.map(result => result.toolCallId))
  const results = [...restResults, ...resultsFromItems(items).filter(result => !resultIds.has(result.toolCallId))]

  return { sends, results, receipts: mergeReceipts(receiptsFromRows(rows), receiptsFromItems(items)) }
}

// ---------------------------------------------------------------------------
// deriveState (spec 4.3, 5.3)
// ---------------------------------------------------------------------------

interface ResultFields {
  status?: string
  reason?: string
  error?: string
  deliveryId?: string
  processId?: string
  /** Only the spawn ack carries it (tools/bot_mode_dm.py:748-756); the live-owner ack never does (:675-689). */
  queuedAt?: number
}

function readResult(result: unknown): ResultFields {
  if (typeof result !== 'object' || result === null || Array.isArray(result)) return {}
  const obj = result as Record<string, unknown>
  const fields: ResultFields = {}
  if (typeof obj.status === 'string') fields.status = obj.status
  if (typeof obj.reason === 'string') fields.reason = obj.reason
  if (typeof obj.error === 'string') fields.error = obj.error
  if (typeof obj.delivery_id === 'string') fields.deliveryId = obj.delivery_id
  if (typeof obj.process_id === 'string') fields.processId = obj.process_id
  if (typeof obj.queued_at === 'number') fields.queuedAt = obj.queued_at
  return fields
}

/**
 * Spec 5.3: a status maps directly; an `error` without a status is read through the reason table.
 * Deliberately without the `status: 'failed'` + `reason` refinement `readBody` applies to receipt
 * bodies: a `message_agent` result is an admission record, never a terminal failure, at this pin.
 */
function deliveryFromResult(fields: ResultFields): Delivery | undefined {
  if (fields.status !== undefined) return deliveryFromStatus(fields.status)
  if (fields.error !== undefined) return deliveryFromReason(fields.reason)
  return undefined
}

/** Spec 5.3 last paragraph: a gone waiter cannot report the outcome of a delivery still in flight. */
function waiterGoneMidFlight(worker: Worker, delivery: Delivery): boolean {
  const gone = worker.kind === 'exited' || worker.kind === 'lost' || worker.kind === 'terminated'
  return gone && (delivery === 'admitted' || delivery === 'queued' || delivery === 'claimed')
}

function replyBodyOf(reply: Reply): string | undefined {
  return reply.kind === 'text' || reply.kind === 'excerpt' ? reply.body : undefined
}

/**
 * Folds the result and the receipt into one exchange state. The receipt is later evidence, so its
 * outcome reading decides delivery, reply and `latestOutcomeUnavailable`; a receipt that only carried
 * a delivery update leaves the result's delivery in place and is reported as `notice`.
 */
export function deriveState(input: { result?: unknown; receipt?: ParsedReceipt; sendDone: boolean }): {
  state: ExchangeState
  evidence: Exchange['evidence']
  replyBody?: string
  notice: boolean
} {
  const fields = readResult(input.result)
  const evidence: Exchange['evidence'] = { provenance: 'structured' }
  if (fields.status !== undefined) evidence.status = fields.status
  if (fields.reason !== undefined) evidence.reason = fields.reason
  if (fields.error !== undefined) evidence.error = fields.error
  if (fields.deliveryId !== undefined) evidence.deliveryId = fields.deliveryId
  if (fields.processId !== undefined) evidence.processId = fields.processId

  let delivery: Delivery = deliveryFromResult(fields) ?? 'unknown'
  let reply: Reply = { kind: 'none' }
  let latestOutcomeUnavailable = false
  let notice = false

  if (input.receipt) {
    if (evidence.processId === undefined) evidence.processId = input.receipt.headline.processId
    // Spec 5.2 rule 5: a `delivery_id` without `queued_at` is the live-owner ack, whose receipt is always JSON.
    const reading = readBody(input.receipt, { pairedResultIsLiveOwner: fields.deliveryId !== undefined && fields.queuedAt === undefined })
    if (reading.kind === 'outcome') {
      delivery = reading.delivery
      reply = reading.reply
      latestOutcomeUnavailable = reading.latestOutcomeUnavailable
      if (reading.status !== undefined) evidence.status = reading.status
      if (reading.reason !== undefined) evidence.reason = reading.reason
      if (reading.error !== undefined) evidence.error = reading.error
      if (reading.deliveryId !== undefined) evidence.deliveryId = reading.deliveryId
    } else {
      notice = true
    }
  }

  const worker: Worker = input.receipt
    ? workerFromHeadline(input.receipt.headline)
    : fields.processId !== undefined && input.sendDone
      ? { kind: 'running' }
      : { kind: 'not_observed' }

  if (waiterGoneMidFlight(worker, delivery)) latestOutcomeUnavailable = true

  const derived: { state: ExchangeState; evidence: Exchange['evidence']; replyBody?: string; notice: boolean } = {
    state: { delivery, worker, reply, latestOutcomeUnavailable },
    evidence,
    notice,
  }
  const body = replyBodyOf(reply)
  if (body !== undefined) derived.replyBody = body
  return derived
}

// ---------------------------------------------------------------------------
// buildExchanges: pairing and the window rule (spec 5.5)
// ---------------------------------------------------------------------------

function uniqueMembers(ids: (string | undefined)[]): string[] {
  const members: string[] = []
  for (const id of ids) {
    if (id !== undefined && !members.includes(id)) members.push(id)
  }
  return members
}

/** Bodies the app actually holds: the sent message, plus a reply body when one was read. */
function bodiesHeld(reply: Reply): number {
  return 1 + (reply.kind === 'text' || reply.kind === 'excerpt' ? 1 : 0)
}

/**
 * Spec 12.1: a send, each distinct outcome it has shown (phase included), a returned response, a
 * receiver-side answer. Tool-call ids are durable, so a refused send with no process id has an id.
 */
export function exchangeIdentities(x: Pick<Exchange, 'anchor' | 'phase' | 'state' | 'reply' | 'evidence' | 'direction'> & { answerRowId?: number }): string[] {
  if (x.direction === 'inbound') {
    return x.answerRowId === undefined ? [] : [`answer:${x.answerRowId}`]
  }
  const call = x.anchor.toolCallId
  if (call === undefined) return []
  const ids = [`send:${call}`, `outcome:${call}:${x.phase}:${x.state.delivery}:${x.state.reply.kind}:${x.state.latestOutcomeUnavailable}`]
  if (x.reply !== undefined && x.evidence.processId !== undefined) ids.push(`return:${x.evidence.processId}`)
  return ids
}

function buildExchange(send: SendEvidence, result: ResultEvidence | undefined, receipt: ReceiptEvidence | undefined, peer: PeerRef): Exchange {
  // A result is the send's own completion: holding one settles the send even if the `tool.complete`
  // that would have flipped `done` was never seen, so "Messaging…" can never be pinned forever.
  const done = send.done || result !== undefined
  const input: { result?: unknown; receipt?: ParsedReceipt; sendDone: boolean } = { sendDone: done }
  if (result !== undefined) input.result = result.result
  if (receipt !== undefined) input.receipt = receipt.receipt
  const derived = deriveState(input)

  const processId = derived.evidence.processId
  const exchange: Exchange = {
    kind: 'exchange',
    id: `x-${send.toolCallId}`,
    direction: 'outbound',
    anchor: send.anchorRowId !== undefined ? { rowId: send.anchorRowId, toolCallId: send.toolCallId } : { toolCallId: send.toolCallId },
    peer,
    sent: send.at !== undefined ? { text: send.message, at: send.at } : { text: send.message },
    state: derived.state,
    phase: done ? 'settled' : 'sending',
    pairing: 'paired',
    members: uniqueMembers([
      send.liveItemId,
      result?.liveItemId,
      receipt?.itemId,
      ...(receipt?.itemIds ?? []),
      processId !== undefined ? `live-receipt-${processId}` : undefined,
      receipt?.rowId !== undefined ? `h-receipt-${receipt.rowId}-${receipt.processId}` : undefined,
    ]),
    identities: [],
    evidence: derived.evidence,
    bodies: bodiesHeld(derived.state.reply),
    notice: derived.notice,
  }

  if (derived.replyBody !== undefined) {
    exchange.reply = receipt?.at !== undefined ? { body: derived.replyBody, at: receipt.at } : { body: derived.replyBody }
  }
  exchange.identities = exchangeIdentities(exchange)
  return exchange
}

/**
 * Pairs sends with their result (by tool call id) and their receipt (by the result's process id),
 * and reports what the loaded window cannot explain: a receipt whose send is missing, and whether an
 * older page must be fetched (spec 5.5).
 */
export function buildExchanges(evidence: Evidence, opts: { roster: RosterPeer[]; registeredPeers?: string[]; window: WindowBounds }): ExchangeBuild {
  const resultByCall = new Map(evidence.results.map(result => [result.toolCallId, result]))
  const receiptByProcess = new Map(evidence.receipts.map(receipt => [receipt.processId, receipt]))

  const exchanges: Exchange[] = []
  const pairedProcesses = new Set<string>()

  for (const send of evidence.sends) {
    const result = resultByCall.get(send.toolCallId)
    const processId = readResult(result?.result).processId
    const receipt = processId !== undefined ? receiptByProcess.get(processId) : undefined
    if (receipt !== undefined) pairedProcesses.add(receipt.processId)
    exchanges.push(buildExchange(send, result, receipt, resolveTarget(send.target, opts.roster, opts.registeredPeers)))
  }

  // A receipt whose process id matches no loaded send. A receipt always follows its own send, so the
  // missing send is necessarily older than the loaded window: while the window has not reached the
  // start it is `not_loaded` (page backward), and once it has, nothing older exists and the receipt
  // is genuinely `unpaired` (spec 5.5).
  const unpaired = evidence.receipts
    .filter(receipt => !pairedProcesses.has(receipt.processId))
    .map(receipt => ({ ...receipt, pairing: opts.window.reachedStart ? ('unpaired' as const) : ('not_loaded' as const) }))

  // A `message_agent` tool row whose assistant row is not loaded is the other backward-paging trigger.
  const sendIds = new Set(evidence.sends.map(send => send.toolCallId))
  const orphanResult = evidence.results.some(result => result.rowId !== undefined && !sendIds.has(result.toolCallId))
  const needsOlder = !opts.window.reachedStart && (orphanResult || unpaired.some(receipt => receipt.pairing === 'not_loaded'))

  return { exchanges, unpaired, needsOlder }
}

// ---------------------------------------------------------------------------
// Copy (spec 5.4) — derived, never stored. "N messages with <peer>" counts every body the app
// holds for the row, sent and reply bodies alike, across merged exchanges.
// ---------------------------------------------------------------------------

const UNKNOWN_OUTCOME = 'Delivery outcome unknown'
const LATEST_OUTCOME_UNAVAILABLE = ' · latest outcome unavailable'

/**
 * The roster display name; a peer with neither a name nor a handle is still named, never blank.
 * A remote peer reads `@<agent> on <peer>`, or `an agent on <peer>` when the agent is unknown
 * (`peers.ts`); the app has no peer-registry read at the Hermes pin, so a bare target that is not
 * a roster profile reads as a local handle.
 */
export function peerName(peer: PeerRef): string {
  return peer.display.name || peer.handle || 'an unknown teammate'
}

/** The 5.4 table for a delivery the app could read; anything the table does not name is an unknown outcome. */
function copyForDelivery(x: Pick<Exchange, 'state' | 'peer' | 'bodies'>): string {
  const name = peerName(x.peer)
  const { delivery, reply } = x.state

  switch (delivery) {
    case 'admitted':
      return reply.kind === 'none' ? `Messaged ${name}` : UNKNOWN_OUTCOME
    case 'queued':
    case 'claimed':
      return reply.kind === 'none' ? `Messaged ${name} · waiting for a reply` : UNKNOWN_OUTCOME
    case 'settled':
      if (reply.kind === 'text') return `${x.bodies} messages with ${name}`
      if (reply.kind === 'excerpt') return `${x.bodies} messages with ${name} · shortened by Hermes`
      if (reply.kind === 'empty') return `Messaged ${name} · no reply text`
      if (reply.kind === 'damaged') return `${name} replied · the reply could not be read`
      return UNKNOWN_OUTCOME
    case 'refused':
      return `${name} could not be reached`
    case 'failed':
      return 'Delivery failed'
    case 'cancelled':
      return 'Delivery cancelled'
    case 'unknown':
      return reply.kind === 'damaged' ? 'Delivery update could not be read' : UNKNOWN_OUTCOME
  }
}

export function memberStates(x: Pick<Exchange, 'phase' | 'state' | 'bodies' | 'group'>): MemberState[] {
  return x.group?.states ?? [{ phase: x.phase, state: x.state, bodies: x.bodies }]
}

/**
 * Spec 12.4: openable when any member holds a recorded body. A send still in flight holds none yet:
 * its text is live tool arguments, not a durable record.
 */
export function isOpenable(x: Pick<Exchange, 'phase' | 'state' | 'bodies' | 'group'>): boolean {
  return memberStates(x).some(m => m.phase !== 'sending' && m.bodies >= 1)
}

type SuffixBucket = 'waiting' | 'failed' | 'refused' | 'cancelled' | 'unknown'
const SUFFIX_ORDER: SuffixBucket[] = ['waiting', 'failed', 'refused', 'cancelled', 'unknown']

/**
 * Which suffix bucket one member falls into. Settled replies and admitted sends with no reply fall
 * into none: the 5.4 table does not call them waiting.
 */
function suffixBucket(m: MemberState): SuffixBucket | null {
  if (m.phase === 'sending') return 'waiting'
  const { delivery, reply, latestOutcomeUnavailable } = m.state
  if (latestOutcomeUnavailable || delivery === 'unknown' || reply.kind === 'damaged') return 'unknown'
  if ((delivery === 'queued' || delivery === 'claimed') && reply.kind === 'none') return 'waiting'
  if (delivery === 'failed') return 'failed'
  if (delivery === 'refused') return 'refused'
  if (delivery === 'cancelled') return 'cancelled'
  return null
}

/**
 * A merged row reflects every member (spec 12.4, supersedes section 11's last-member suffix): counts
 * of members that are waiting, failed, refused, cancelled or unknown, in that order.
 */
function mergedSuffix(x: Pick<Exchange, 'phase' | 'state' | 'bodies' | 'group'>): string {
  const counts = new Map<SuffixBucket, number>()
  for (const member of memberStates(x)) {
    const bucket = suffixBucket(member)
    if (bucket !== null) counts.set(bucket, (counts.get(bucket) ?? 0) + 1)
  }
  return SUFFIX_ORDER.filter(bucket => counts.has(bucket))
    .map(bucket => ` · ${counts.get(bucket)} ${bucket}`)
    .join('')
}

/** The row's visible text (spec 5.4, 12.4). Never throws: every unnamed combination reads as an unknown outcome. */
export function exchangeCopy(x: Pick<Exchange, 'state' | 'phase' | 'peer' | 'bodies' | 'pairing' | 'group'> & Partial<Pick<Exchange, 'direction' | 'reply'>>): string {
  if (x.group !== undefined && x.group.count > 1) return `${x.bodies} messages with ${peerName(x.peer)}${mergedSuffix(x)}`
  // A teammate's answer to this bot's own dispatch (spec 13): the row stands for that one message, as Desktop's note does.
  if (x.direction === 'inbound' && x.reply === undefined) return `Message from ${peerName(x.peer)}`
  const base = x.phase === 'sending' ? `Messaging ${peerName(x.peer)}…` : copyForDelivery(x)
  return x.state.latestOutcomeUnavailable ? base + LATEST_OUTCOME_UNAVAILABLE : base
}

// ---------------------------------------------------------------------------
// Merging consecutive exchanges with the same peer (spec 5.4)
// ---------------------------------------------------------------------------

/**
 * Folds two adjacent exchanges with the same peer into one row: the bodies add up (the N of
 * "N messages with <peer>"), the later exchange owns the state, and the first one keeps the anchor
 * so the row never moves.
 * Adjacency is the timeline's decision (spec 5.4), not this function's.
 */
export function mergeConsecutive(a: Exchange, b: Exchange): Exchange {
  const merged: Exchange = {
    ...a,
    state: b.state,
    phase: b.phase,
    pairing: b.pairing,
    evidence: b.evidence,
    bodies: a.bodies + b.bodies,
    members: [...a.members, ...b.members],
    identities: [...a.identities, ...b.identities],
    notice: a.notice || b.notice,
    group: { count: (a.group?.count ?? 1) + (b.group?.count ?? 1), states: [...memberStates(a), ...memberStates(b)] },
  }
  if (b.reply !== undefined) merged.reply = b.reply
  else delete merged.reply
  return merged
}
