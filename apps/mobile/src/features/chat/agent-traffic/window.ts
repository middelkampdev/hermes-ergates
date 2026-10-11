/**
 * The REST transcript window: what the app holds of the durable transcript, and
 * every rule that decides which page to ask for next (spec 5.5 window, 5.8 fetch
 * scheduling).
 *
 * Pure: no React or React Native imports (ADR-029 rule 1). `use-transcript.ts` is
 * the React adapter around these functions; `test/fake-gateway/scenarios.ts`
 * drives the same functions in Node, so the rules are tested once.
 *
 * Row ids are a global autoincrement across sessions, so one session's ids are
 * NOT contiguous: nothing here does id arithmetic. Adjacency is decided by
 * "a row id we already hold" or by a short page.
 */

import type { TranscriptPage, TranscriptRow } from '@/gateway/types'

/** Chat open: the latest page (spec 5.5). */
export const FIRST_PAGE_LIMIT = 500
/** Every tail fetch after a turn, a process notification or a `message_agent` completion (spec 5.8). */
export const TAIL_LIMIT = 50
/** How many pages one automatic backward run may fetch (spec 5.5). */
export const AUTO_PAGE_BUDGET = 4

const MESSAGE_AGENT = 'message_agent'

export interface TranscriptWindow {
  sessionId: string | null
  /** Ascending by id, deduped. */
  rows: TranscriptRow[]
  oldestLoadedRowId: number | null
  newestLoadedRowId: number | null
  /** The oldest row of the session is loaded: there is nothing further back to ask for. */
  reachedStart: boolean
  loaded: boolean
  /** The last fetch's failure, already safe to render; cleared by the next page that merges. */
  error: string | null
  /** Backward pages fetched automatically; the manual "Older messages" control does not count. */
  autoPages: number
}

export function emptyWindow(): TranscriptWindow {
  return { sessionId: null, rows: [], oldestLoadedRowId: null, newestLoadedRowId: null, reachedStart: false, loaded: false, error: null, autoPages: 0 }
}

/** What a page was fetched for: the first page, one page further back, or the newest end. */
export type PageKind = 'initial' | 'older' | 'tail'

/**
 * Folds a page into the window: rows deduped by id (the newer copy wins) and
 * sorted ascending, bounds updated, the previous error cleared.
 *
 * A page that came back shorter than the limit it asked for means the route ran
 * out of rows, so the window has reached the start of the recorded chat —
 * whichever fetch asked for it.
 *
 * `manual: true` merges an "Older messages" tap, which pages without a budget:
 * it is the only backward page that does not count against `autoPages`.
 */
export function mergePage(w: TranscriptWindow, page: TranscriptPage, kind: PageKind, opts: { manual?: boolean } = {}): TranscriptWindow {
  const byId = new Map<number, TranscriptRow>()
  for (const row of w.rows) {
    byId.set(row.id, row)
  }
  for (const row of page.rows) {
    byId.set(row.id, row)
  }
  const rows = [...byId.values()].sort((a, b) => a.id - b.id)
  const short = page.page.returned < page.page.limit

  return {
    sessionId: page.sessionId || w.sessionId,
    rows,
    oldestLoadedRowId: rows[0]?.id ?? null,
    newestLoadedRowId: rows[rows.length - 1]?.id ?? null,
    reachedStart: w.reachedStart || short,
    loaded: true,
    error: null,
    autoPages: kind === 'older' && !opts.manual ? w.autoPages + 1 : w.autoPages
  }
}

/**
 * The next page further back. `order: 'latest'` counts from the newest end and
 * the window is contiguous from that end, so the offset is simply how many rows
 * are already loaded.
 */
export function olderQuery(w: TranscriptWindow): { limit: number; offset: number; order: 'latest' } {
  return { limit: FIRST_PAGE_LIMIT, offset: w.rows.length, order: 'latest' }
}

export function tailQuery(offset: number): { limit: number; offset: number; order: 'latest' } {
  return { limit: TAIL_LIMIT, offset, order: 'latest' }
}

/**
 * Has a tail page reached the rows the window already held? `w` must be the
 * window as it was BEFORE the tail run started — merging a page makes its own
 * newest row the window's newest, which would make every later page of the same
 * run look like an overlap and leave a hole between the two blocks.
 */
export function tailOverlaps(w: TranscriptWindow, page: TranscriptPage): boolean {
  if (page.page.returned < page.page.limit) {
    return true
  }
  const newest = w.newestLoadedRowId
  return newest !== null && page.rows.some(row => row.id <= newest)
}

export function canAutoPageOlder(w: TranscriptWindow): boolean {
  return w.loaded && !w.reachedStart && w.autoPages < AUTO_PAGE_BUDGET
}

/**
 * What a fetch was started for. A page that comes back after any of it changed
 * belongs to another chat, another epoch or an older revision, and is discarded
 * (spec 5.8).
 */
export interface FetchBinding {
  connectionId: string
  profile: string
  liveSessionId: string | null
  epoch: string | null
  revision: number
}

export function sameBinding(a: FetchBinding, b: FetchBinding): boolean {
  return a.connectionId === b.connectionId && a.profile === b.profile && a.liveSessionId === b.liveSessionId && a.epoch === b.epoch && a.revision === b.revision
}

/**
 * The live observations this page makes durable (spec 5.8): the tool call ids of
 * its `message_agent` result rows. The reducer drops the live twins of exactly
 * these, and nothing else — absence from a page is never evidence of absence.
 *
 * A recorded result row may have lost its `tool_name`, so a row is also a
 * `message_agent` result when its tool call id matches a `message_agent` call on
 * an assistant row of the same page (`exchange.ts` pairs results the same way).
 */
export function reconciledIds(page: TranscriptPage): { toolCallIds: string[] } {
  const sendIds = new Set<string>()
  for (const row of page.rows) {
    for (const call of row.toolCalls ?? []) {
      if (call.name === MESSAGE_AGENT) {
        sendIds.add(call.id)
      }
    }
  }

  const toolCallIds: string[] = []
  for (const row of page.rows) {
    if (row.role === 'tool' && row.toolCallId !== undefined && (row.toolName === MESSAGE_AGENT || sendIds.has(row.toolCallId)) && !toolCallIds.includes(row.toolCallId)) {
      toolCallIds.push(row.toolCallId)
    }
  }
  return { toolCallIds }
}
