/**
 * Pure session reducer: turns gateway events and local submit outcomes into
 * the rendered chat state for ONE session (ADR-029 rule 3). Both the real
 * and the fake gateway drive this reducer. No React Native imports.
 */

import type {
  ActivateResult,
  ApprovalRequestParams,
  BackgroundCompletePayload,
  ClarifyRequestParams,
  ErrorPayload,
  GatewayEventFrame,
  HistoryMessage,
  MessageCompletePayload,
  MessageInterimPayload,
  OpenServerRequest,
  ReplayResult,
  RequestCancelPayload,
  ServerRequestFrame,
  SessionInfoPayload,
  StatusUpdatePayload,
  TextPayload,
  ToolCompletePayload,
  ToolStartPayload,
  UsagePayload
} from '@/gateway/types'

import { PROCESS_TITLE_RE, parseReceiptRow } from './agent-traffic/receipt'
import { historyToItems, maxRowId, mergeHistory, newestInputRowId, type ChatItem, type DeliveryState, type LiveAnchor } from './history'

export type { ChatItem, DeliveryState } from './history'

/**
 * Who started the running turn (spec 5.8): this device's send (`local`), someone
 * or something else (`foreign`), or a turn we found already running and cannot
 * attribute (`unknown`). Human delivery transitions apply to `local` turns only.
 */
export type TurnOwnership = 'local' | 'foreign' | 'unknown'

/**
 * The fields of a resume payload the reducer reads: the idle snapshot (methods_session.py:684-770)
 * and the server requests still open (`open_requests`, left out when empty).
 */
export interface ResumeSnapshot { status: string; running: boolean; inflight?: unknown; hydrating?: boolean; auto_continue?: unknown; open_requests?: OpenServerRequest[] }

/**
 * Spec 12.3: the last turn may fold on idle evidence only under a snapshot confirmed against
 * reconciled knowledge: idle, not running, no inflight, and no pending hydration or scheduled
 * auto-continuation learned from a resume payload. An activate payload carries neither field, so
 * its silence clears nothing; any newer live event invalidates the snapshot until the next payload.
 */
export interface IdleSnapshot { confirmed: boolean; hydrating: boolean; autoContinue: boolean }

export interface LiveTurn {
  streaming: boolean
  assistantText: string
  reasoningText: string
  statusLine: string | null
  turnStartedAt: number | null
  /** `null` when no turn is running. */
  ownership: TurnOwnership | null
}

export interface SessionState {
  liveSessionId: string | null
  storedSessionId: string | null
  items: ChatItem[]
  live: LiveTurn
  replay: { lastSeq: number; epoch: string | null; needsHistoryRefetch: boolean }
  connection: 'idle' | 'connecting' | 'open' | 'closed' | 'error'
  usage: UsagePayload | null
  info: SessionInfoPayload | null
  lastError: string | null
  /**
   * Bumped by every settled change a history snapshot could overwrite (spec
   * 5.8). A fetch captures it at start; a result that no longer matches is
   * discarded instead of rolling the newer state back.
   */
  revision: number
  /** How many REST tail fetches the observed events have asked for (spec 5.8). */
  tailWanted: number
  /** The retained error of a failed turn, as `session.activate` reports it. */
  inflightError: string | null
  /** Where the running turn started (spec 12.3 anchor); `null` when no turn is running. */
  turnAnchor: LiveAnchor | null
  /** What the last resume or activate payload says about the session being idle (spec 12.3). */
  idleSnapshot: IdleSnapshot
  /**
   * The process id of the last receipt a `status.update {kind:"process"}` named (rule g). The next
   * turn to start is the one Hermes runs on that receipt row, so the id moves onto its anchor;
   * cleared when a turn starts (consumed) and at a reconnect boundary (rule h). Only a 0.21.2 server sends a
   * receipt live: v0.21.6 sends a title without a process id, so the id stays null there.
   */
  pendingReceiptProcessId: string | null
}

export type SessionAction =
  | { type: 'session/bound'; liveSessionId: string; storedSessionId: string; epoch?: string | null }
  | { type: 'session/activated'; result: ActivateResult; at?: number }
  /** The `session.resume` payload the chat opened with: the only carrier of hydration and auto-continue. */
  | { type: 'session/resumed'; snapshot: ResumeSnapshot }
  /** `revision` is the one captured before the fetch; a mismatch means the snapshot is stale. */
  | { type: 'history/loaded'; messages: HistoryMessage[]; revision?: number }
  | { type: 'connection/state'; state: SessionState['connection'] }
  | { type: 'event'; event: GatewayEventFrame; at?: number }
  /** A server request from the connection, live or re-delivered from `open_requests`. */
  | { type: 'request/received'; request: ServerRequestFrame }
  | { type: 'submit/started'; localId: string; text: string; at: number }
  | { type: 'submit/acknowledged'; localId: string }
  /** The gateway parked it behind the running turn (`prompt.submit` → `{status:'queued'}`). */
  | { type: 'submit/queued'; localId: string }
  /** It became a live correction, not a user turn (`{status:'redirected'|'steered'}`). */
  | { type: 'submit/correction'; localId: string; status: 'redirected' | 'steered'; at?: number }
  /** Never left the device: no connection when Send was pressed. */
  | { type: 'submit/unsent'; localId: string }
  | { type: 'submit/failed'; localId: string; message: string }
  | { type: 'submit/unconfirmed'; localId: string }
  | { type: 'submit/retry'; localId: string }
  /** Durable outbox entries restored after a restart, oldest first. */
  | { type: 'outbox/restored'; items: { localId: string; text: string; at: number; delivery: DeliveryState }[] }
  | { type: 'clarify/failed'; requestId: string; message: string }
  /** A local failure the user should see once (a refused Stop, a failed response). */
  | { type: 'error/raised'; message: string }
  | { type: 'approval/responded'; requestId: string; choice: string }
  | { type: 'clarify/responded'; requestId: string; answers: Record<string, string> }
  | { type: 'clarify/dismissed'; requestId: string }
  /** A turn was already running when we (re)attached (`opened.running`, `session.activate`). */
  | { type: 'turn/observed-running'; at?: number }
  /** Durable transcript rows arrived for live-only observations; drop the duplicates. */
  | { type: 'transcript/reconciled'; toolCallIds: string[] }
  | { type: 'replay/result'; result: ReplayResult }
  | { type: 'history/refetched' }
  | { type: 'error/cleared' }

export const initialSessionState: SessionState = {
  liveSessionId: null,
  storedSessionId: null,
  items: [],
  live: idleTurn(),
  replay: { lastSeq: 0, epoch: null, needsHistoryRefetch: false },
  connection: 'idle',
  usage: null,
  info: null,
  lastError: null,
  revision: 0,
  tailWanted: 0,
  inflightError: null,
  turnAnchor: null,
  idleSnapshot: { confirmed: false, hydrating: false, autoContinue: false },
  pendingReceiptProcessId: null
}

/** Events that carry no session id but still matter to a session view. */
const GLOBAL_EVENTS = new Set(['gateway.ready', 'skin.changed', 'error'])

/**
 * Anything that says the session did something after the payload was taken: the snapshot is stale
 * until the next resume or activate payload (spec 12.3).
 */
const INVALIDATING_EVENTS = new Set([
  'message.start',
  'message.delta',
  'message.interim',
  'message.complete',
  'status.update',
  'tool.start',
  'tool.complete',
  'background.complete',
  'error',
  'session.resume_progress'
])

let counter = 0
const nextId = (prefix: string) => `${prefix}-${++counter}`

/**
 * A send of ours that the gateway accepted and whose turn has not ended:
 * `acknowledged` (its turn is starting or running) or `queued` (parked behind
 * the running turn). The gateway marks the session running before it answers
 * `prompt.submit` (tui_gateway/methods_prompt.py:531 at the pin), so this is
 * true before the turn's first event arrives. A turn's end drops the local id
 * (`sealUserTurns`).
 */
export function localTurnPending(state: SessionState): boolean {
  return state.items.some(i => i.kind === 'user' && Boolean(i.localId) && (i.delivery === 'acknowledged' || i.delivery === 'queued'))
}

export function sessionReducer(state: SessionState, action: SessionAction): SessionState {
  switch (action.type) {
    case 'session/bound':
      return {
        ...state,
        liveSessionId: action.liveSessionId,
        storedSessionId: action.storedSessionId,
        replay: { ...state.replay, epoch: action.epoch ?? state.replay.epoch }
      }
    case 'session/activated':
      return expireUnlisted(applyActivate(state, action.result, action.at), action.result.open_requests)
    case 'session/resumed':
      return {
        ...expireUnlisted(state, action.snapshot.open_requests),
        idleSnapshot: confirmIdle(action.snapshot, {
          hydrating: action.snapshot.hydrating === true,
          autoContinue: action.snapshot.auto_continue !== undefined && action.snapshot.auto_continue !== null
        }),
        // Rule (h): a resume boundary means the paired turn may have run unseen, so a pending
        // receipt cannot be trusted to belong to whatever turn starts next.
        pendingReceiptProcessId: null
      }
    case 'history/loaded': {
      // The fetch captured the revision it started from; anything settled since
      // then (a completion, a receipt) is newer than this snapshot, which would
      // roll it back. Drop it — `use-session` schedules a fresh one (spec 5.8).
      if (action.revision !== undefined && action.revision !== state.revision) {
        return state
      }
      const fresh = historyToItems(action.messages)
      const nonHistory = state.items.filter(i => i.kind === 'clarify' || i.kind === 'approval')
      const merged = mergeHistory(state.items.filter(i => i.kind !== 'clarify' && i.kind !== 'approval'), fresh)
      return { ...state, items: [...merged, ...nonHistory.filter(i => i.kind === 'approval' ? i.state === 'pending' : i.state === 'pending')] }
    }
    case 'history/refetched':
      return { ...state, replay: { ...state.replay, needsHistoryRefetch: false } }
    case 'connection/state':
      return { ...state, connection: action.state }
    case 'submit/started':
      return {
        ...state,
        items: [...state.items, { kind: 'user', id: `local-${action.localId}`, localId: action.localId, text: action.text, at: action.at, delivery: 'submitting' }]
      }
    case 'submit/acknowledged':
      return setDelivery(state, action.localId, 'acknowledged')
    case 'submit/queued':
      return setDelivery(state, action.localId, 'queued')
    case 'submit/unsent':
      return setDelivery(state, action.localId, 'queued_unsent')
    case 'submit/correction': {
      // The gateway injected the text into the running turn instead of starting a
      // user turn, so it will never appear in durable history. Render it as what it
      // was — a course correction — not as a message bubble that later goes
      // "unconfirmed" on the next history merge.
      const item = state.items.find(i => i.kind === 'user' && i.localId === action.localId)
      const text = item?.kind === 'user' ? item.text : ''
      return {
        ...state,
        items: state.items.map(i =>
          i.kind === 'user' && i.localId === action.localId
            ? { kind: 'event', id: i.id, text: `Course correction: ${text}`, at: i.at ?? action.at }
            : i
        )
      }
    }
    case 'submit/failed':
      return { ...setDelivery(state, action.localId, 'failed'), lastError: action.message }
    case 'submit/unconfirmed':
      return setDelivery(state, action.localId, 'unconfirmed')
    case 'submit/retry':
      return setDelivery(state, action.localId, 'submitting')
    case 'outbox/restored': {
      const known = new Set(state.items.filter(i => i.kind === 'user' && i.localId).map(i => (i.kind === 'user' ? i.localId : '')))
      const restored = action.items
        .filter(i => !known.has(i.localId))
        .map(i => ({ kind: 'user' as const, id: `local-${i.localId}`, localId: i.localId, text: i.text, at: i.at, delivery: i.delivery }))
      return restored.length === 0 ? state : { ...state, items: [...state.items, ...restored] }
    }
    case 'clarify/failed':
      return {
        ...state,
        lastError: action.message,
        items: state.items.map(i => (i.kind === 'clarify' && i.requestId === action.requestId ? { ...i, error: action.message } : i))
      }
    // A resolved card is a settled change: a snapshot captured before it must
    // not put the pending card back (spec 5.8).
    case 'approval/responded':
      return {
        ...state,
        revision: state.revision + 1,
        items: state.items.map(i => (i.kind === 'approval' && i.requestId === action.requestId ? { ...i, state: 'resolved', choice: action.choice } : i))
      }
    case 'clarify/responded':
      return {
        ...state,
        revision: state.revision + 1,
        items: state.items.map(i => (i.kind === 'clarify' && i.requestId === action.requestId ? { ...i, state: 'answered', answers: action.answers, error: undefined } : i))
      }
    case 'clarify/dismissed':
      return {
        ...state,
        revision: state.revision + 1,
        items: state.items.map(i => (i.kind === 'clarify' && i.requestId === action.requestId ? { ...i, state: 'dismissed' } : i))
      }
    case 'turn/observed-running':
      // We did not see this turn start, so it may be one whose completion we
      // already missed: `unknown`, unless a send of ours is still waiting.
      return invalidateIdle(startTurn(state, 'unknown', action.at))
    case 'transcript/reconciled': {
      const toolCallIds = new Set(action.toolCallIds)
      const items = state.items.filter(i => !(i.kind === 'tool' && i.toolId !== undefined && toolCallIds.has(i.toolId)))
      return items.length === state.items.length ? state : { ...state, items }
    }
    case 'replay/result':
      return applyReplay(state, action.result)
    case 'error/raised':
      return { ...state, lastError: action.message }
    case 'error/cleared':
      return { ...state, lastError: null }
    case 'event':
      return applyEvent(state, action.event, action.at)
    case 'request/received':
      return receiveRequest(state, action.request)
    default:
      return state
  }
}

/** The card a server request shows, or null for a method the phone shows no card for. */
function requestCard(request: ServerRequestFrame): Extract<ChatItem, { kind: 'approval' | 'clarify' }> | null {
  if (request.method === 'approval') {
    return { kind: 'approval', id: `approval-${request.id}`, requestId: request.id, payload: request.params as ApprovalRequestParams, state: 'pending' }
  }
  if (request.method === 'clarify') {
    const asked = (request.params as Partial<ClarifyRequestParams>).questions
    const questions = (Array.isArray(asked) ? asked : []).map(q => ({ qid: q.qid, question: q.question, choices: Array.isArray(q.choices) ? q.choices : [], multi_select: q.multi_select ?? false }))
    return { kind: 'clarify', id: `clarify-${request.id}`, requestId: request.id, questions, state: 'pending' }
  }
  return null
}

/**
 * One card per request id. A pending card stays as it is. A card in any other state goes back to
 * pending: Hermes delivers a request again only while it still waits for the answer, so the answer
 * the card shows never arrived. The socket already dropped the one re-delivery that proves nothing,
 * a snapshot that Hermes took on the answering socket before the answer reached it
 * (`SocketSession.takeRequest`). Hermes Desktop also keys its cards on the id and lets a
 * re-delivery replace the entry (apps/desktop/src/store/server-requests.ts:12-14).
 */
function receiveRequest(state: SessionState, request: ServerRequestFrame): SessionState {
  if (!state.liveSessionId || request.params.session_id !== state.liveSessionId) {
    return state
  }
  const card = requestCard(request)
  if (!card) {
    return state
  }
  const index = state.items.findIndex(i => i.kind === card.kind && i.requestId === request.id)
  const existing = index >= 0 ? state.items[index] : undefined
  if (existing && (existing.kind === 'approval' || existing.kind === 'clarify') && existing.state === 'pending') {
    return state
  }
  const items = existing ? state.items.map((i, at) => (at === index ? card : i)) : [...state.items, card]
  // The turn now waits on the user: no working line, and the idle snapshot is stale.
  return invalidateIdle({ ...state, items, live: { ...state.live, statusLine: null } })
}

/**
 * A reconnect or resume payload lists every server request Hermes still waits on (`open_requests`,
 * left out when empty). A pending card it does not list is over, even when its `request.cancel` was
 * lost to a truncated replay or a restart.
 */
function expireUnlisted(state: SessionState, open: OpenServerRequest[] | undefined): SessionState {
  const listed = new Set((open ?? []).map(r => r.id))
  let changed = false
  const items = state.items.map(i => {
    if ((i.kind === 'approval' || i.kind === 'clarify') && i.state === 'pending' && !listed.has(i.requestId)) {
      changed = true
      return { ...i, state: 'expired' as const }
    }
    return i
  })
  return changed ? { ...state, items, revision: state.revision + 1 } : state
}

/**
 * The reason a turn failed, as the backend actually reports it
 * (tui_gateway/prompt_turn.py:629-683): `error` on every failed turn,
 * `failure_reason` only alongside the billing-wall descriptor.
 */
function turnFailure(p: MessageCompletePayload): { message: string; retryable?: boolean } {
  const message = (typeof p.error === 'string' && p.error.trim()) || (typeof p.failure_reason === 'string' && p.failure_reason.trim()) || 'The turn failed.'
  return { message, retryable: p.error_surface?.retryable }
}

/** No turn is running: empty buffers, no owner. */
function idleTurn(): LiveTurn {
  return { streaming: false, assistantText: '', reasoningText: '', statusLine: null, turnStartedAt: null, ownership: null }
}

/**
 * Spec 12.3: idle, not running, nothing inflight, and nothing the session already told us it still
 * owes — a hydration in progress or an auto-continuation it scheduled. `pending` carries those two
 * forward because only a resume payload ever reports them.
 */
function confirmIdle(snapshot: { status: string; running: boolean; inflight?: unknown }, pending: Pick<IdleSnapshot, 'hydrating' | 'autoContinue'>): IdleSnapshot {
  const confirmed =
    snapshot.status === 'idle' &&
    snapshot.running === false &&
    (snapshot.inflight === undefined || snapshot.inflight === null) &&
    !pending.hydrating &&
    !pending.autoContinue
  return { confirmed, hydrating: pending.hydrating, autoContinue: pending.autoContinue }
}

/** Anything newer than the payload makes it stale: the snapshot holds until the next one. */
function invalidateIdle(state: SessionState): SessionState {
  return state.idleSnapshot.confirmed ? { ...state, idleSnapshot: { ...state.idleSnapshot, confirmed: false } } : state
}

/** Deliveries that mean a send of ours is still waiting for its turn (spec 5.8). */
const LOCAL_IN_FLIGHT = new Set<DeliveryState>(['submitting', 'acknowledged', 'queued'])

function hasLocalSendInFlight(items: ChatItem[]): boolean {
  return items.some(i => i.kind === 'user' && Boolean(i.localId) && i.delivery !== undefined && LOCAL_IN_FLIGHT.has(i.delivery))
}

/**
 * The anchor of a starting turn. When we did not watch the turn start (`observed`), its input row
 * is already durable, so record it: `resolveAnchorRowId` uses it when the refetch delivers no newer
 * input row at all.
 */
function observedAnchor(items: ChatItem[], observed: boolean): LiveAnchor {
  const anchor: LiveAnchor = { afterRowId: maxRowId(items) }
  if (!observed) return anchor
  const inputRowId = newestInputRowId(items)
  if (inputRowId !== undefined) anchor.observedInputRowId = inputRowId
  return anchor
}

/**
 * A turn began. Ownership decides everything that follows (spec 5.8): only a
 * `local` turn moves a human delivery state, and only a `local` completion is
 * the answer to a send this device is holding. A start that arrives while a turn
 * is already running is the same turn seen twice — collapse it by phase and keep
 * the buffers and the owner, or the streamed answer so far is thrown away.
 *
 * `unownedAs` is `foreign` for a `message.start` we watched arrive, and
 * `unknown` for a turn we merely found running. A turn we merely found running
 * also records the newest input row already in history: that row is its own
 * input (spec 12.3 anchor), so a later refetch that brings
 * no new input row still anchors the answer.
 */
function startTurn(state: SessionState, unownedAs: 'foreign' | 'unknown', at: number | undefined): SessionState {
  if (state.live.streaming) {
    return state
  }
  const ownership: TurnOwnership = hasLocalSendInFlight(state.items) ? 'local' : unownedAs
  const items = ownership === 'local' ? promoteOldestQueued(state.items) : state.items
  // Only a turn that is neither ours nor watched starting has a durable input row of its own.
  const anchor: LiveAnchor = observedAnchor(items, unownedAs === 'unknown' && ownership !== 'local')
  if (ownership === 'local') {
    const running = items.find(i => i.kind === 'user' && Boolean(i.localId) && (i.delivery === 'submitting' || i.delivery === 'acknowledged'))
    if (running) anchor.userItemId = running.id
  } else if (state.pendingReceiptProcessId !== null) {
    // Rule (g)/(h): a receipt landed (with nothing running, or mid-stream of a turn it cannot
    // belong to), and now a turn we did not start begins — that receipt's durable row is this
    // turn's input row.
    anchor.processId = state.pendingReceiptProcessId
  }
  return {
    ...state,
    // Consumed (or, for a local turn, not ours to use): it belongs to at most one turn.
    pendingReceiptProcessId: null,
    // The oldest message the gateway parked behind the previous turn is now
    // running; later queued ones keep their local identity until their turn.
    items,
    live: { ...idleTurn(), streaming: true, turnStartedAt: at ?? Date.now(), ownership },
    turnAnchor: anchor,
    lastError: null
  }
}

/**
 * A background process or a subagent wrote a durable row and the backend told us so
 * (`status.update {kind:"process"}`). Desktop adds nothing for any of them and only re-reads its
 * process list (apps/desktop/src/app/session/hooks/use-message-stream/gateway-event/status.ts:116-119),
 * so no item is added here either: the REST tail brings the durable row (5.8), and the text never
 * reaches the working line (spec 5.9). v0.21.6 sends a one-line title for a completion or a subagent
 * and the full text for a watch match (tui_gateway/session_notifications.py:546-552).
 */
function applyProcessNotification(state: SessionState, text: string): SessionState {
  const parsed = PROCESS_TITLE_RE.test(text) ? null : parseReceiptRow(text)
  // Rule (h): a receipt observed while a turn streams cannot belong to that turn — it already
  // started — so its process id is remembered for whichever turn starts next, same as when nothing
  // is running. Last receipt wins either way.
  const processId = parsed?.kind === 'receipts' ? parsed.receipts.at(-1)!.headline.processId : null
  return { ...state, pendingReceiptProcessId: processId ?? state.pendingReceiptProcessId, tailWanted: state.tailWanted + 1 }
}

/**
 * A completed turn's user rows are durable now (the row is written at turn end),
 * so drop their local identity: they are history, and a later refetch replaces
 * them instead of re-labelling them "unconfirmed". Queued and in-flight items
 * keep theirs — they belong to a turn that has not run yet.
 */
function promoteOldestQueued(items: ChatItem[]): ChatItem[] {
  // An acknowledged send of ours still holds its local id until its turn ends
  // (`sealUserTurns`), so the turn starting now is that send's, not a queued one's.
  if (items.some(i => i.kind === 'user' && Boolean(i.localId) && i.delivery === 'acknowledged')) {
    return items
  }
  const index = items.findIndex(i => i.kind === 'user' && i.delivery === 'queued')
  if (index < 0) {
    return items
  }
  const target = items[index]
  return items.map((i, at) => (at === index && target.kind === 'user' ? { ...target, delivery: 'acknowledged' as const } : i))
}

function sealUserTurns(items: ChatItem[]): ChatItem[] {
  let changed = false
  const next = items.map(i => {
    if (i.kind !== 'user' || !i.localId || i.delivery !== 'acknowledged') {
      return i
    }
    changed = true
    const { localId: _localId, ...rest } = i
    return { ...rest, kind: 'user' as const }
  })
  return changed ? next : items
}

function setDelivery(state: SessionState, localId: string, delivery: DeliveryState): SessionState {
  return {
    ...state,
    items: state.items.map(i => (i.kind === 'user' && i.localId === localId ? { ...i, delivery } : i))
  }
}

/**
 * Fold a `session.activate` result: the reconnect-time truth about the live turn.
 *
 * Running: restore the partial assistant text from `inflight` so a reconnect
 * mid-stream continues where the deltas stopped. Not running while we still
 * believed we were streaming: the end of that turn was lost with the socket, so
 * the durable transcript is the only place the answer exists — ask for it.
 */
/**
 * Spec 12.3: the turn ended somewhere we could not watch — the socket dropped, or the session
 * reported an error mid-stream. The text we did stream is real and must not vanish, but whether
 * the turn finished is not knowable from here: keep it with the outcome `unknown`, which never
 * folds. Nothing to seal when no text was streamed.
 */
function sealUnknownTurn(state: SessionState, at: number | undefined): Pick<SessionState, 'items' | 'revision'> | null {
  if (!state.live.assistantText.trim()) {
    return null
  }
  const reasoning = state.live.reasoningText.trim() ? state.live.reasoningText : undefined
  const liveAnchor: LiveAnchor = state.turnAnchor ?? { afterRowId: maxRowId(state.items) }
  return {
    items: [...state.items, { kind: 'assistant', id: nextId('live-assistant'), text: state.live.assistantText, at: at ?? Date.now(), reasoning, turnOutcome: 'unknown', liveAnchor }],
    revision: state.revision + 1
  }
}

function applyActivate(state: SessionState, result: ActivateResult, at?: number): SessionState {
  const inflight = result.inflight ?? null
  const running = Boolean(result.running) || Boolean(inflight?.streaming)
  const inflightError = typeof inflight?.error === 'string' ? inflight.error : null
  // An activate payload reports neither hydration nor a scheduled auto-continuation, so its
  // silence clears neither: carry both forward from what a resume payload last said (spec 12.3).
  const idleSnapshot = confirmIdle({ status: result.status, running, inflight }, state.idleSnapshot)
  if (running) {
    return {
      ...state,
      idleSnapshot,
      live: {
        ...state.live,
        streaming: true,
        assistantText: inflight?.assistant ? inflight.assistant : state.live.assistantText,
        turnStartedAt: state.live.turnStartedAt ?? (typeof result.turn_started_at === 'number' ? result.turn_started_at * 1000 : (at ?? Date.now())),
        // The turn we were already streaming keeps its owner; one we find
        // running here was never attributed, so it is only ours while a send of
        // ours is still waiting (spec 5.8).
        ownership: (state.live.streaming ? state.live.ownership : null) ?? (hasLocalSendInFlight(state.items) ? 'local' : 'unknown')
      },
      info: result.info ?? state.info,
      inflightError,
      // A turn found running here was never watched starting: record the durable input row it
      // must have. One we were already streaming keeps its anchor.
      turnAnchor: state.turnAnchor ?? observedAnchor(state.items, !state.live.streaming && !hasLocalSendInFlight(state.items)),
      // Rule (h): a reconnect boundary — the paired turn may have run unseen — discards a
      // pending receipt rather than misattributing it to whatever turn is found running here.
      pendingReceiptProcessId: null
    }
  }
  const missedTurnEnd = state.live.streaming
  const sealed = missedTurnEnd ? sealUnknownTurn(state, at) : null
  return {
    ...state,
    ...(sealed ?? {}),
    idleSnapshot,
    live: idleTurn(),
    info: result.info ?? state.info,
    inflightError,
    turnAnchor: null,
    // Rule (h): same reconnect-boundary reasoning as the running branch above.
    pendingReceiptProcessId: null,
    replay: missedTurnEnd ? { ...state.replay, needsHistoryRefetch: true } : state.replay
  }
}

function applyReplay(state: SessionState, result: ReplayResult): SessionState {
  let next = state
  const epochChanged = Boolean(result.epoch) && Boolean(state.replay.epoch) && result.epoch !== state.replay.epoch
  if (epochChanged) {
    next = { ...next, replay: { lastSeq: 0, epoch: result.epoch, needsHistoryRefetch: true } }
  } else if (result.epoch && !state.replay.epoch) {
    next = { ...next, replay: { ...next.replay, epoch: result.epoch } }
  }
  if (result.truncated) {
    next = { ...next, replay: { ...next.replay, needsHistoryRefetch: true } }
  }
  for (const event of result.events ?? []) {
    next = applyEvent(next, event)
  }
  return next
}

function applyEvent(state: SessionState, event: GatewayEventFrame, at?: number): SessionState {
  if (!event || typeof event.type !== 'string') {
    return state
  }
  const sid = event.session_id ?? ''
  if (sid) {
    // Before the session is bound there is nothing to compare against, and backend
    // seqs are per-session: accepting a foreign frame here would advance the shared
    // watermark and mute this session's whole stream.
    if (!state.liveSessionId || sid !== state.liveSessionId) {
      return state
    }
  } else if (!GLOBAL_EVENTS.has(event.type)) {
    return state
  }

  let next = state
  if (typeof event.seq === 'number' && Number.isFinite(event.seq) && sid) {
    if (event.seq <= state.replay.lastSeq) {
      return state
    }
    next = { ...state, replay: { ...state.replay, lastSeq: event.seq } }
  }

  if (INVALIDATING_EVENTS.has(event.type)) {
    next = invalidateIdle(next)
  }

  const raw: unknown = event.payload ?? {}
  const payload = raw as Record<string, unknown>

  switch (event.type) {
    case 'session.resume_progress': {
      // Hydration is only ever reported live; a completed (or failed) history phase is the one
      // thing that clears what the resume payload said was still pending (spec 12.3).
      const p = raw as { phase?: string; status?: string }
      if (p.phase === 'history' && (p.status === 'complete' || p.status === 'failed')) {
        return { ...next, idleSnapshot: { ...next.idleSnapshot, hydrating: false } }
      }
      return next
    }
    case 'gateway.ready': {
      const epoch = typeof payload.replay_epoch === 'string' ? payload.replay_epoch : null
      if (epoch && next.replay.epoch && epoch !== next.replay.epoch) {
        return { ...next, replay: { lastSeq: 0, epoch, needsHistoryRefetch: true } }
      }
      if (epoch && !next.replay.epoch) {
        return { ...next, replay: { ...next.replay, epoch } }
      }
      return next
    }
    case 'message.start':
      return startTurn(next, 'foreign', at)
    case 'message.delta': {
      const text = (raw as TextPayload).text ?? ''
      return { ...next, live: { ...next.live, streaming: true, assistantText: next.live.assistantText + text } }
    }
    case 'message.interim': {
      // Commentary the model emits alongside tool calls — NOT the answer. It must
      // never touch the streaming buffer: overwriting `assistantText` threw away
      // the deltas so far and the rest of the answer appended to the commentary.
      const p = raw as MessageInterimPayload
      const text = (p.text ?? '').trim()
      if (!text || p.already_streamed) {
        return next
      }
      if (next.items.some(i => i.kind === 'commentary' && i.text === text)) {
        return next
      }
      return { ...next, items: [...next.items, { kind: 'commentary', id: nextId('commentary'), text, at: at ?? Date.now() }] }
    }
    case 'thinking.delta': {
      const text = (raw as TextPayload).text ?? ''
      return { ...next, live: { ...next.live, statusLine: text || next.live.statusLine } }
    }
    case 'reasoning.delta': {
      const text = (raw as TextPayload).text ?? ''
      return { ...next, live: { ...next.live, reasoningText: next.live.reasoningText + text } }
    }
    case 'reasoning.available': {
      const text = (raw as TextPayload).text ?? ''
      return { ...next, live: { ...next.live, reasoningText: text } }
    }
    case 'status.update': {
      const p = raw as StatusUpdatePayload
      if (p.kind === 'process') {
        return applyProcessNotification(next, p.text ?? '')
      }
      const text = p.text ?? p.message ?? p.status ?? null
      return { ...next, live: { ...next.live, statusLine: text } }
    }
    case 'message.complete': {
      const p = raw as MessageCompletePayload
      const text = typeof p.text === 'string' && p.text ? p.text : next.live.assistantText
      const reasoning = next.live.reasoningText.trim() ? next.live.reasoningText : undefined
      const failed = p.status === 'error'
      const failure = failed ? turnFailure(p) : undefined
      // Only OUR turn's user rows are durable now; a foreign or unknown turn
      // says nothing about a send of ours that is still waiting (spec 5.8).
      const ownedLocally = next.live.ownership === 'local'
      const sealed = ownedLocally ? sealUserTurns(next.items) : next.items
      const turnOutcome = failed ? 'failed' as const : 'completed' as const
      const liveAnchor: LiveAnchor = next.turnAnchor ?? { afterRowId: maxRowId(next.items) }
      // Seal the turn locally. `session.history` has no pagination (contract B.5) —
      // it returns the whole transcript — and the Bot Chat is a forever chat, so a
      // refetch after every reply does not hold up on a phone. A full refetch is
      // forced only by truncation, an epoch change or pull-to-refresh.
      const items = text.trim() || reasoning
        ? [...sealed, { kind: 'assistant' as const, id: nextId('live-assistant'), text, at: at ?? Date.now(), reasoning, error: failure?.message, retryable: failure?.retryable, turnOutcome, liveAnchor }]
        : sealed
      return {
        ...next,
        items,
        live: idleTurn(),
        turnAnchor: null,
        // Rule (h): a receipt observed mid-stream survives the completion of the turn it
        // interrupted — it belongs to whichever turn starts next, not this one. Only a turn
        // start (startTurn) or a reconnect boundary (session/activated, session/resumed) clears it.
        usage: p.usage ?? next.usage,
        lastError: failure ? failure.message : next.lastError,
        revision: next.revision + 1,
        // A local turn reconciles through the REST tail; a turn we did not start
        // (or cannot attribute) can only be read from durable history.
        tailWanted: ownedLocally ? next.tailWanted + 1 : next.tailWanted,
        replay: ownedLocally ? next.replay : { ...next.replay, needsHistoryRefetch: true },
        // Whatever turn was scheduled to continue, one has now ended: stop blocking on it (spec 12.3).
        idleSnapshot: { ...next.idleSnapshot, autoContinue: false }
      }
    }
    case 'tool.start': {
      const p = raw as ToolStartPayload
      if (!p.tool_id) {
        return next
      }
      if (next.items.some(i => i.kind === 'tool' && i.toolId === p.tool_id)) {
        return next
      }
      return {
        ...next,
        items: [...next.items, { kind: 'tool', id: `tool-${p.tool_id}`, toolId: p.tool_id, name: p.name ?? 'tool', context: p.context, args: p.args, done: false }]
      }
    }
    case 'tool.complete': {
      const p = raw as ToolCompletePayload
      if (!p.tool_id) {
        return next
      }
      const exists = next.items.some(i => i.kind === 'tool' && i.toolId === p.tool_id)
      const updated: ChatItem = { kind: 'tool', id: `tool-${p.tool_id}`, toolId: p.tool_id, name: p.name ?? 'tool', args: p.args, result: p.result, durationS: p.duration_s, done: true, error: p.error }
      return {
        ...next,
        items: exists
          // A completion frame need not repeat the call's arguments; when it does not, the start
          // frame's are the only ones there are (spec A.14) and must not be erased.
          ? next.items.map(i => (i.kind === 'tool' && i.toolId === p.tool_id ? { ...i, ...updated, args: p.args ?? i.args, context: i.context } : i))
          : [...next.items, updated],
        revision: next.revision + 1,
        // The send's result is live-only until the transcript carries it (5.8).
        tailWanted: p.name === 'message_agent' ? next.tailWanted + 1 : next.tailWanted
      }
    }
    case 'request.cancel': {
      // Hermes stopped waiting for this request: expire its card only (server_requests.py:145-146).
      const p = raw as Partial<RequestCancelPayload>
      if (typeof p.id !== 'string') {
        return next
      }
      return {
        ...next,
        revision: next.revision + 1,
        items: next.items.map(i => ((i.kind === 'approval' || i.kind === 'clarify') && i.requestId === p.id && i.state === 'pending' ? { ...i, state: 'expired' as const } : i))
      }
    }
    case 'session.info':
      return { ...next, info: raw as SessionInfoPayload }
    case 'session.usage': {
      const usage = (raw as { usage?: UsagePayload }).usage
      return usage ? { ...next, usage } : next
    }
    case 'background.complete': {
      // The real payload is `{task_id, text}` (spec 5.9): there is no sender
      // field, so the old "Message from <agent>" line was never emitted. The
      // text is process output — Activity detail only, never a bubble.
      const p = raw as BackgroundCompletePayload
      return {
        ...next,
        items: [...next.items, { kind: 'notice', id: nextId('notice'), noticeKind: 'process', detail: p.text ?? '', at: at ?? Date.now(), live: true }]
      }
    }
    case 'error': {
      const p = raw as ErrorPayload
      // The session gave up mid-stream: seal what streamed as an unknown outcome (spec 12.3).
      const sealed = next.live.streaming ? sealUnknownTurn(next, at) : null
      return {
        ...next,
        ...(sealed ?? {}),
        // The turn is over either way, so the anchor it started from is stale.
        turnAnchor: null,
        lastError: typeof p.message === 'string' && p.message ? p.message : 'Hermes reported an error',
        // Once the text and the reasoning live on the sealed item, leaving them on `live` too
        // lists the same reasoning twice in Activity. Nothing sealed means nothing was moved:
        // keep the buffers, or the reasoning of a turn that streamed none of its answer is lost.
        live: sealed ? idleTurn() : { ...next.live, streaming: false, statusLine: null }
      }
    }
    default:
      return next
  }
}
