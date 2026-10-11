/**
 * History rows -> chat items, and the merge of a fresh history fetch with
 * local (not yet durable) user items. Pure; no React Native imports.
 */

import type { ApprovalRequestParams, ClarifyQuestion, HistoryMessage } from '@/gateway/types'

import { classifyUserRow, A2A_DISPLAY_KIND, PROCESS_COMPLETE_DISPLAY_KIND, type RowClass } from './agent-traffic/classify'
import type { ParsedReceipt } from './agent-traffic/receipt'

/**
 * Delivery of one composer message.
 *  - `submitting`    the RPC is in flight
 *  - `acknowledged`  the gateway accepted it (`{status:'streaming'}`) or history shows it
 *  - `queued`        accepted but parked behind the running turn (`{status:'queued'}`)
 *  - `queued_unsent` never left the device (no connection); sent automatically on reconnect
 *  - `unconfirmed`   sent, outcome unknown (timeout/network); only the user may resend
 *  - `failed`        definitely refused
 */
export type DeliveryState = 'submitting' | 'acknowledged' | 'queued' | 'unconfirmed' | 'failed' | 'queued_unsent'

export type TurnOutcome = 'completed' | 'failed' | 'unknown'

/**
 * Where a live turn started, as the reducer knew the chat then (spec 12.3 input-row anchor).
 * Reconciliation uses it to find the answer's durable input row: for a local turn the one fresh user
 * row with the local send's text, else the one fresh input row of any kind (`resolveAnchorRowId`).
 */
export interface LiveAnchor {
  /** The newest durable row id known when the turn started; `null` when none was. */
  afterRowId: number | null
  /** The local user item (`local-<localId>`) this turn ran, for a local turn. */
  userItemId?: string
  /**
   * The newest input row already in history when the turn was found already running
   * (`turn/observed-running`, or a running activate the reducer was not streaming through).
   * Hermes runs one turn per session, so that row is the running turn's own input: it was
   * persisted before we ever looked, and no later refetch will deliver it as "new".
   */
  observedInputRowId?: number
  /**
   * The newest row id of the fresh snapshot that retained this answer for the first time.
   * A turn that starts after it cannot be the home of an answer that was already sealed,
   * so it bounds the candidate set. Never changed afterwards.
   */
  retainedBeforeRowId?: number
  /** How many reconciliations in a row failed to place this answer. */
  retainedRounds?: number
  /**
   * The process id of the receipt a `status.update {kind:"process"}` named just before this turn
   * started (rule g). Hermes writes the receipt as a durable input row and then runs a turn on it, so
   * that row is this turn's input row — found by its hard process id (spec 5.2/5.5), never by
   * order or text.
   */
  processId?: string
}

export type ChatItem =
  | { kind: 'user'; id: string; rowId?: number; localId?: string; text: string; at?: number; delivery?: DeliveryState }
  /**
   * `displayKind` is set on the v0.21.6 `failed_turn` row Hermes closes a failed turn with. It stays an
   * assistant item, the durable row of its turn for reconciliation; the timeline draws it as Desktop's system row.
   * `errorCard` is set when Desktop also draws an error card, an assistant message, in front of that row.
   */
  | { kind: 'assistant'; id: string; rowId?: number; text: string; at?: number; reasoning?: string; streaming?: boolean; error?: string; retryable?: boolean; turnOutcome?: TurnOutcome; liveAnchor?: LiveAnchor; displayKind?: typeof FAILED_TURN_DISPLAY_KIND; errorCard?: true }
  /** Assistant commentary emitted alongside tool calls (`message.interim`), never part of the answer. */
  | { kind: 'commentary'; id: string; text: string; at?: number }
  | { kind: 'tool'; id: string; toolId?: string; name: string; context?: string; args?: Record<string, unknown>; result?: unknown; durationS?: number; done: boolean; error?: string }
  | { kind: 'event'; id: string; text: string; at?: number }
  /** On this card and the approval card, `requestId` is the server request id (`srq-<12 hex>`) the answer goes back to. */
  | { kind: 'clarify'; id: string; requestId: string; questions: ClarifyQuestion[]; state: 'pending' | 'answered' | 'expired' | 'dismissed'; answers?: Record<string, string>; error?: string }
  | { kind: 'approval'; id: string; requestId: string; payload: ApprovalRequestParams; state: 'pending' | 'resolved' | 'expired'; choice?: string }
  /** Inbound agent-to-agent message, from a validated `a2a_message` stamp or the legacy inferred text grammar (spec 5.1/5.6). */
  | { kind: 'bot_message'; id: string; rowId?: number; handle: string; name: string; text: string; at?: number; provenance: 'structured' | 'inferred'; senderId?: string; deliveryId?: string }
  /**
   * One parsed `[IMPORTANT: Background process …]` receipt (spec 5.2). `displayKind` is set when the
   * row was stored as a v0.21.6 `process_complete` row, which Desktop shows as a system row.
   */
  | { kind: 'receipt'; id: string; rowId?: number; receipt: ParsedReceipt; at?: number; displayKind?: typeof PROCESS_COMPLETE_DISPLAY_KIND }
  /** A receipt-shaped row that failed to parse, or another `[IMPORTANT: …]` notice. `displayKind` as on a receipt. */
  | { kind: 'notice'; id: string; rowId?: number; noticeKind: 'delivery_update' | 'process' | 'batch' | 'unknown'; at?: number; detail: string; live?: boolean; displayKind?: typeof PROCESS_COMPLETE_DISPLAY_KIND }

const HIDDEN_KINDS = new Set(['hidden'])

/** Display kinds that render as compact centered rows instead of bubbles. */
const EVENT_KINDS = new Set(['model_switch', 'personality_switch', 'async_delegation_complete', 'auto_continue'])

/**
 * The assistant row Hermes v0.21.6 closes a failed turn with (agent/turn_failure_copy.py:39-48,
 * agent/conversation_loop.py:1848-1850, gateway/run_turn.py:1719-1721). Both history projections type
 * rows written before that too (tui_gateway/session_history.py:264-271, :358; hermes_cli/web_routers/sessions.py:692-695).
 */
export const FAILED_TURN_DISPLAY_KIND = 'failed_turn'

/** The error-surface layers Desktop knows (apps/desktop/src/lib/error-surface.ts:10-19). */
const ERROR_SURFACE_LAYERS = new Set(['provider', 'endpoint', 'streaming', 'auth', 'billing', 'gateway', 'runtime', 'disk'])

/**
 * Does Desktop draw an error card in front of a failed_turn row? Only when its `display_metadata`, an
 * object or the JSON text an older backend serves, holds an `error_surface` with a known layer
 * (apps/desktop/src/lib/chat-messages/hydration.ts:179-208, :579-591; error-surface.ts:100-122).
 */
function hasErrorCard(metadata: unknown): boolean {
  let parsed = metadata
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed)
    } catch {
      return false
    }
  }
  const surface = parsed !== null && typeof parsed === 'object' ? (parsed as { error_surface?: unknown }).error_surface : undefined
  const layer = surface !== null && typeof surface === 'object' ? (surface as { layer?: unknown }).layer : undefined
  return typeof layer === 'string' && ERROR_SURFACE_LAYERS.has(layer)
}

export function historyToItems(messages: HistoryMessage[]): ChatItem[] {
  const items: ChatItem[] = []
  let toolCounter = 0
  for (const m of messages) {
    if (!m || typeof m !== 'object') {
      continue
    }
    if (m.display_kind && HIDDEN_KINDS.has(m.display_kind)) {
      continue
    }
    if (m.role === 'tool') {
      toolCounter += 1
      items.push({
        kind: 'tool',
        id: `h-tool-${m.row_id ?? toolCounter}-${m.name ?? 'tool'}`,
        name: m.name ?? 'tool',
        context: m.context,
        args: m.args,
        done: true
      })
      continue
    }
    const text = typeof m.text === 'string' ? m.text : ''
    const reasoning = typeof m.reasoning === 'string' && m.reasoning.trim() ? m.reasoning : undefined
    if (m.role === 'user') {
      if (!text.trim()) {
        continue
      }

      // Position-based fallback (matches `rowIdOf`'s `i${index}` scheme) so two
      // rows without a `row_id` never collide on the same generated id.
      const rowKey = rowKeyOf(m.row_id, items.length)

      let classified: RowClass | undefined
      if (m.display_kind === A2A_DISPLAY_KIND) {
        classified = classifyUserRow({ text, displayKind: m.display_kind, displayMetadata: m.display_metadata })
        if (classified.kind === 'bot_message') {
          items.push(botMessageItem(m, rowKey, classified))
          continue
        }
      }

      if (m.display_kind && EVENT_KINDS.has(m.display_kind)) {
        items.push({ kind: 'event', id: `h-event-${m.row_id ?? items.length}`, text, at: m.timestamp })
        continue
      }

      classified ??= classifyUserRow({ text, displayKind: m.display_kind, displayMetadata: m.display_metadata })
      // Desktop shows a `process_complete` row as a system row, not a user row; the fold reads it so (timeline.ts).
      const typed: { displayKind?: typeof PROCESS_COMPLETE_DISPLAY_KIND } = m.display_kind === PROCESS_COMPLETE_DISPLAY_KIND ? { displayKind: PROCESS_COMPLETE_DISPLAY_KIND } : {}
      if (classified.kind === 'receipts') {
        for (const receipt of classified.receipts) {
          items.push({ kind: 'receipt', id: `h-receipt-${rowKey}-${receipt.headline.processId}`, rowId: m.row_id, receipt, at: m.timestamp, ...typed })
        }
        continue
      }
      if (classified.kind === 'notice') {
        items.push({ kind: 'notice', id: `h-notice-${rowKey}`, rowId: m.row_id, noticeKind: classified.noticeKind, at: m.timestamp, detail: classified.detail, ...typed })
        continue
      }
      if (classified.kind === 'bot_message') {
        items.push(botMessageItem(m, rowKey, classified))
        continue
      }

      items.push({ kind: 'user', id: rowIdOf(m, 'user', items.length), rowId: m.row_id, text, at: m.timestamp, delivery: 'acknowledged' })
      continue
    }
    if (m.role === 'assistant') {
      if (!text.trim() && !reasoning) {
        continue
      }
      if (m.display_kind && EVENT_KINDS.has(m.display_kind)) {
        items.push({ kind: 'event', id: `h-event-${m.row_id ?? items.length}`, text, at: m.timestamp })
        continue
      }
      const failedTurn: { displayKind?: typeof FAILED_TURN_DISPLAY_KIND; errorCard?: true } = {}
      if (m.display_kind === FAILED_TURN_DISPLAY_KIND) {
        failedTurn.displayKind = FAILED_TURN_DISPLAY_KIND
        if (hasErrorCard(m.display_metadata)) failedTurn.errorCard = true
      }
      items.push({ kind: 'assistant', id: rowIdOf(m, 'assistant', items.length), rowId: m.row_id, text, at: m.timestamp, reasoning, ...failedTurn })
    }
  }
  return items
}

function rowIdOf(m: HistoryMessage, role: string, index: number): string {
  return m.row_id !== undefined ? `h-${role}-${m.row_id}` : `h-${role}-i${index}`
}

/** `rowId` when the row has one, else a positional fallback (`i${index}`) so ids never collide. */
function rowKeyOf(rowId: number | undefined, index: number): string {
  return rowId !== undefined ? `${rowId}` : `i${index}`
}

function botMessageItem(m: HistoryMessage, rowKey: string, cls: Extract<RowClass, { kind: 'bot_message' }>): Extract<ChatItem, { kind: 'bot_message' }> {
  return {
    kind: 'bot_message',
    id: `h-bot-${rowKey}`,
    rowId: m.row_id,
    handle: cls.handle,
    name: cls.name,
    text: cls.text,
    at: m.timestamp,
    provenance: cls.provenance,
    senderId: cls.senderId,
    deliveryId: cls.deliveryId
  }
}

/** A row the user or another agent put into the conversation: it ends a run of mergeable exchanges (spec 5.4). */
export function isInputRow(item: ChatItem): boolean {
  switch (item.kind) {
    case 'user':
    case 'bot_message':
    case 'receipt':
    case 'notice':
      return true
    case 'event':
      // An event item carries no row id, and every event draws a visible centered row anyway:
      // counting it as an input row is the conservative reading (it can only prevent a merge).
      return true
    default:
      return false
  }
}

export function hasText(item: ChatItem): boolean {
  return item.kind === 'assistant' && item.text.trim().length > 0
}

export function maxRowId(items: ChatItem[]): number | null {
  let max: number | null = null
  for (const item of items) {
    const rowId = (item as { rowId?: number }).rowId
    if (rowId !== undefined && (max === null || rowId > max)) max = rowId
  }
  return max
}

/** The newest row id among the input rows of `items`, or `undefined` when none carries one. */
export function newestInputRowId(items: ChatItem[]): number | undefined {
  let max: number | undefined
  for (const item of items) {
    if (!isInputRow(item)) continue
    const rowId = (item as { rowId?: number }).rowId
    if (rowId !== undefined && (max === undefined || rowId > max)) max = rowId
  }
  return max
}

/**
 * Fresh input rows newer than everything the live turn knew at its start, each paired with its
 * index in `fresh` so its owning turn's unique answer can be located (rule d below).
 */
function newInputRowCandidates(fresh: ChatItem[], afterRowId: number | null): { row: ChatItem; index: number }[] {
  const out: { row: ChatItem; index: number }[] = []
  fresh.forEach((item, index) => {
    if (!isInputRow(item)) return
    const rowId = (item as { rowId?: number }).rowId
    if (rowId === undefined) return
    if (afterRowId !== null && rowId <= afterRowId) return
    out.push({ row: item, index })
  })
  return out
}

/**
 * Rule (d): a candidate turn is excluded when its own unique answer row already carries a
 * `turnOutcome` in `fresh` — carried forward from a previous reconciliation, or just transferred
 * onto it by an earlier live item processed in this same round. That turn is already explained by
 * another observation, so it cannot also be this live answer's home. The exclusion is by this
 * recorded fact on a row id alone, never by ordering or text.
 */
function turnAlreadyExplained(fresh: ChatItem[], candidateIndex: number): boolean {
  const answer = uniqueAnswerIndex(fresh, candidateIndex)
  if (answer === undefined) return false
  const row = fresh[answer]!
  return row.kind === 'assistant' && row.turnOutcome !== undefined
}

/**
 * Rule (e): a candidate turn that holds no assistant row with text after its last tool row (zero
 * answers, e.g. a receipt row whose own turn has not answered yet) cannot be the home of a sealed
 * answer: it is excluded from the candidate set. A turn with two or more answers stays a candidate
 * — that ambiguity still means retaining, unchanged. The exclusion is by this row fact alone,
 * never by ordering or text.
 */
function turnHasNoAnswer(fresh: ChatItem[], candidateIndex: number): boolean {
  return answersAfterLastTool(fresh, candidateIndex).length === 0
}

/**
 * The input row id of the durable turn a live answer belongs to (spec 12.3): for a local
 * turn, exactly one fresh user row with the local send's text among the new rows; otherwise exactly
 * one new input row of any kind. Anything else is ambiguous and yields `undefined` — except a turn
 * we found already running, whose input row was persisted before we looked: when the snapshot
 * carries no newer input row at all, that recorded row is the anchor. Both
 * the newer-than-`afterRowId` set and the `observedInputRowId` fallback exclude a turn already
 * explained by a recorded outcome (rule d).
 */
export function resolveAnchorRowId(items: ChatItem[], fresh: ChatItem[], anchor: LiveAnchor): number | undefined {
  // Rule (g): the turn ran on a receipt row, and a receipt carries a process id. When the durable
  // row is there, its id is the anchor — a hard-id pairing (spec 5.2/5.5), so it needs no help
  // from the candidate rules. When it is not there yet, fall through to them unchanged.
  if (anchor.processId !== undefined) {
    const byProcess = fresh.filter(
      (i): i is Extract<ChatItem, { kind: 'receipt' }> =>
        i.kind === 'receipt' && i.rowId !== undefined && i.receipt.headline.processId === anchor.processId
    )
    if (byProcess.length === 1) return byProcess[0]!.rowId
  }
  const candidates = newInputRowCandidates(fresh, anchor.afterRowId).filter(
    c => !turnAlreadyExplained(fresh, c.index) && !turnHasNoAnswer(fresh, c.index)
  )
  if (anchor.userItemId !== undefined) {
    const local = items.find(item => item.id === anchor.userItemId)
    if (local?.kind === 'user') {
      const matches = candidates.filter(c => c.row.kind === 'user' && c.row.text === local.text)
      if (matches.length === 1) return (matches[0]!.row as { rowId: number }).rowId
    }
  }
  if (candidates.length === 1) return (candidates[0]!.row as { rowId: number }).rowId
  if (candidates.length === 0 && anchor.observedInputRowId !== undefined) {
    const index = fresh.findIndex(row => (row as { rowId?: number }).rowId === anchor.observedInputRowId)
    if (index !== -1 && (turnAlreadyExplained(fresh, index) || turnHasNoAnswer(fresh, index))) return undefined
    return anchor.observedInputRowId
  }
  return undefined
}

/** The assistant rows with text after the last tool row of the turn that starts at `start`. */
function answersAfterLastTool(fresh: ChatItem[], start: number): number[] {
  let end = fresh.length
  for (let i = start + 1; i < fresh.length; i += 1) {
    if (isInputRow(fresh[i]!)) { end = i; break }
  }
  let lastTool = start
  for (let i = start + 1; i < end; i += 1) if (fresh[i]!.kind === 'tool') lastTool = i
  const answers: number[] = []
  for (let i = lastTool + 1; i < end; i += 1) if (hasText(fresh[i]!)) answers.push(i)
  return answers
}

/** The one assistant row with text after the last tool row of the turn that starts at `start`, or `undefined`. */
function uniqueAnswerIndex(fresh: ChatItem[], start: number): number | undefined {
  const answers = answersAfterLastTool(fresh, start)
  return answers.length === 1 ? answers[0] : undefined
}

/**
 * Spec 12.3: carry every recorded outcome forward by row id, so an outcome survives reconciliation
 * (spec 12.6), then move each live sealed answer's outcome onto its durable row when — and only
 * when — the match is unambiguous; a moved outcome overrides the carried copy. A live answer
 * without such a match is retained, with its outcome, until the next reconciliation.
 */
export function transferOutcomes(items: ChatItem[], fresh: ChatItem[]): { fresh: ChatItem[]; retained: ChatItem[] } {
  const previous = new Map<number, TurnOutcome>()
  for (const item of items) {
    if (item.kind === 'assistant' && item.rowId !== undefined && item.turnOutcome !== undefined) previous.set(item.rowId, item.turnOutcome)
  }
  const next = fresh.map(item => {
    if (item.kind !== 'assistant' || item.rowId === undefined) return item
    const outcome = previous.get(item.rowId)
    return outcome === undefined ? item : { ...item, turnOutcome: outcome }
  })

  type LiveSealed = Extract<ChatItem, { kind: 'assistant' }> & { rowId: undefined; turnOutcome: TurnOutcome; liveAnchor: LiveAnchor }
  const isLiveSealed = (item: ChatItem): item is LiveSealed =>
    item.kind === 'assistant' && item.rowId === undefined && item.turnOutcome !== undefined && item.liveAnchor !== undefined

  // Rule (f): a fixed point over the still-retained items. Each pass tries every item not yet
  // placed; when a pass transfers at least one outcome, a later item's transfer can newly explain
  // (rule d) or newly answer a turn that an earlier item in this same call could not place, so the
  // still-retained set is re-run until a pass places nothing more.
  let pending: LiveSealed[] = items.filter(isLiveSealed)
  let transferredThisPass = true
  while (pending.length > 0 && transferredThisPass) {
    transferredThisPass = false
    const stillPending: LiveSealed[] = []
    for (const item of pending) {
      // `next`, not `fresh`: it carries forward outcomes from earlier reconciliations and, as
      // passes proceed, the outcomes transferred onto other live items too — so rule (d) sees a
      // turn's answer as already explained the moment it is.
      const anchorRowId = resolveAnchorRowId(items, next, item.liveAnchor)
      const start = anchorRowId === undefined ? -1 : next.findIndex(row => (row as { rowId?: number }).rowId === anchorRowId)
      const answer = start === -1 ? undefined : uniqueAnswerIndex(next, start)
      if (answer === undefined) {
        stillPending.push(item)
        continue
      }
      const target = next[answer]!
      if (target.kind === 'assistant') next[answer] = { ...target, turnOutcome: item.turnOutcome }
      transferredThisPass = true
    }
    pending = stillPending
  }

  // `retainedRounds`/`retainedBeforeRowId` are updated once per call, for the items still
  // retained once the fixed point above is reached.
  const retained: ChatItem[] = []
  for (const item of pending) {
    const rounds = (item.liveAnchor.retainedRounds ?? 0) + 1
    // A completed answer is the one case where dropping is honest: its turn ended well, the
    // durable transcript already holds the same text, and a second failure to place it means
    // no later reconciliation ever will. `failed`/`unknown` are kept.
    if (item.turnOutcome === 'completed' && rounds >= 2) continue
    const liveAnchor: LiveAnchor = { ...item.liveAnchor, retainedRounds: rounds }
    if (liveAnchor.retainedBeforeRowId === undefined) {
      const newest = maxRowId(fresh)
      if (newest !== null) liveAnchor.retainedBeforeRowId = newest
    }
    retained.push({ ...item, liveAnchor })
  }
  return { fresh: next, retained }
}

/** Deliveries that mean "the gateway has it", so a matching durable row is the same message. */
const DURABLE_ONCE_SENT = new Set<DeliveryState>(['acknowledged', 'queued', 'unconfirmed', 'submitting'])

/**
 * Replace history-derived items with `fresh`, keeping:
 *  - local user items whose delivery is still uncertain. A sent local item is
 *    dropped when a fresh user row with the same text exists; an acknowledged
 *    one that history does not show is kept and marked unconfirmed so the user
 *    can decide. (`queued`, `queued_unsent` and `failed` items are never
 *    re-labelled: those states are known exactly, and history is not expected
 *    to show them yet.)
 *  - live notices whose exact `detail` text does not appear among `fresh`'s
 *    notices (a notice has no id to pair on, so the text is the only evidence
 *    the same notification is now durable).
 *  - `message_agent` tool items (identified by `toolId`), which never appear
 *    in history at all.
 *  - live sealed answers whose outcome found no unambiguous durable row (spec 12.3).
 *
 * Survivors are appended after `fresh`, in their original relative order.
 */
export function mergeHistory(items: ChatItem[], fresh: ChatItem[]): ChatItem[] {
  const { fresh: reconciled, retained } = transferOutcomes(items, fresh)
  // Keyed by id: the retained item carries an updated `liveAnchor` (bound and round count),
  // so the survivor must be the returned copy, not the original.
  const retainedById = new Map(retained.map(i => [i.id, i]))
  const freshUserTexts = reconciled.filter(i => i.kind === 'user').map(i => (i as Extract<ChatItem, { kind: 'user' }>).text)
  // A notice carries no id of any kind, so its durable twin can only be found by
  // its exact text; the spec forbids text matching only where it names
  // an id to pair on.
  const freshNoticeDetails = new Set(reconciled.filter((i): i is Extract<ChatItem, { kind: 'notice' }> => i.kind === 'notice').map(i => i.detail))

  const survivors: ChatItem[] = []
  for (const item of items) {
    if (item.kind === 'assistant' && retainedById.has(item.id)) {
      survivors.push(retainedById.get(item.id)!)
      continue
    }
    if (item.kind === 'user' && item.localId && !item.rowId) {
      const matched = freshUserTexts.includes(item.text)
      if (matched && item.delivery && DURABLE_ONCE_SENT.has(item.delivery)) {
        continue
      }
      survivors.push(item.delivery === 'acknowledged' ? { ...item, delivery: 'unconfirmed' } : item)
      continue
    }
    if (item.kind === 'notice' && item.live && !freshNoticeDetails.has(item.detail)) {
      survivors.push(item)
      continue
    }
    if (item.kind === 'tool' && item.toolId && item.name === 'message_agent') {
      survivors.push(item)
      continue
    }
  }
  return [...reconciled, ...survivors]
}
