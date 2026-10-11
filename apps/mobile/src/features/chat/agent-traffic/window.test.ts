import { describe, expect, it } from 'vitest'

import senderPageRaw from '@test/fixtures/agent-traffic/transcript-sender.json'

import { normalizeTranscriptPage } from './transcript'
import type { TranscriptPage, TranscriptRow } from './types'
import {
  AUTO_PAGE_BUDGET,
  FIRST_PAGE_LIMIT,
  TAIL_LIMIT,
  canAutoPageOlder,
  emptyWindow,
  mergePage,
  olderQuery,
  reconciledIds,
  sameBinding,
  tailOverlaps,
  tailQuery,
  type FetchBinding,
  type TranscriptWindow
} from './window'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function row(id: number, over: Partial<TranscriptRow> = {}): TranscriptRow {
  return { id, role: 'user', text: `row ${id}`, content: `row ${id}`, ...over }
}

/** A page as the REST route answers it: `returned` defaults to the row count. */
function page(rows: TranscriptRow[], p: Partial<TranscriptPage['page']> = {}): TranscriptPage {
  return { sessionId: 's1', rows, page: { limit: TAIL_LIMIT, offset: 0, returned: rows.length, ...p } }
}

const binding: FetchBinding = { connectionId: 'primary', profile: 'default', liveSessionId: 'live-1', epoch: 'epoch-1', revision: 3 }

/** A window that holds `count` rows ending at `newest`, none of them short. */
function windowOf(ids: number[], over: Partial<TranscriptWindow> = {}): TranscriptWindow {
  const merged = mergePage(emptyWindow(), page(ids.map(id => row(id)), { limit: ids.length + 1, returned: ids.length }), 'initial')
  return { ...merged, reachedStart: false, ...over }
}

// ---------------------------------------------------------------------------

describe('transcript window', () => {
  it('starts empty', () => {
    expect(emptyWindow()).toEqual({
      sessionId: null,
      rows: [],
      oldestLoadedRowId: null,
      newestLoadedRowId: null,
      reachedStart: false,
      loaded: false,
      error: null,
      autoPages: 0
    })
  })

  it('merges a page deduped by id, sorted ascending, and records the bounds', () => {
    const first = mergePage(emptyWindow(), page([row(120), row(101), row(110)], { limit: FIRST_PAGE_LIMIT, returned: 3 }), 'initial')
    expect(first.rows.map(r => r.id)).toEqual([101, 110, 120])
    expect(first).toMatchObject({ sessionId: 's1', loaded: true, error: null, oldestLoadedRowId: 101, newestLoadedRowId: 120, autoPages: 0 })

    // Row ids are a global autoincrement, so an older page's ids are lower but not contiguous.
    const older = mergePage(first, page([row(40), row(101), row(77)], { limit: FIRST_PAGE_LIMIT, offset: 3, returned: 3 }), 'older')
    expect(older.rows.map(r => r.id)).toEqual([40, 77, 101, 110, 120])
    expect(older).toMatchObject({ oldestLoadedRowId: 40, newestLoadedRowId: 120, autoPages: 1 })
  })

  it('takes the newer copy of a row that arrives twice', () => {
    const first = mergePage(emptyWindow(), page([row(10, { text: 'stale' })], { limit: FIRST_PAGE_LIMIT }), 'initial')
    const again = mergePage(first, page([row(10, { text: 'fresh' })], { limit: TAIL_LIMIT }), 'tail')
    expect(again.rows).toHaveLength(1)
    expect(again.rows[0]?.text).toBe('fresh')
  })

  it('clears a previous error when a page merges', () => {
    const failed: TranscriptWindow = { ...emptyWindow(), error: 'No connection to the gateway.' }
    expect(mergePage(failed, page([row(1)], { limit: FIRST_PAGE_LIMIT }), 'initial').error).toBeNull()
  })

  it('reaches the start on a short page, whatever fetched it', () => {
    const short = mergePage(emptyWindow(), page([row(1), row(2)], { limit: FIRST_PAGE_LIMIT, returned: 2 }), 'initial')
    expect(short.reachedStart).toBe(true)

    const full = mergePage(emptyWindow(), page([row(1), row(2)], { limit: 2, returned: 2 }), 'initial')
    expect(full.reachedStart).toBe(false)

    const shortTail = mergePage(full, page([row(3)], { limit: TAIL_LIMIT, returned: 1 }), 'tail')
    expect(shortTail.reachedStart).toBe(true)

    // Once reached, a later full page never un-reaches it.
    expect(mergePage(shortTail, page([row(4), row(5)], { limit: 2, returned: 2 }), 'older').reachedStart).toBe(true)
  })

  it('counts automatic older pages, but not a manual one', () => {
    const auto = mergePage(windowOf([10, 11]), page([row(8), row(9)], { limit: 2, returned: 2 }), 'older')
    expect(auto.autoPages).toBe(1)

    const manual = mergePage(windowOf([10, 11]), page([row(8), row(9)], { limit: 2, returned: 2 }), 'older', { manual: true })
    expect(manual.autoPages).toBe(0)

    // Only backward paging counts against the budget.
    expect(mergePage(windowOf([10, 11]), page([row(12)], { limit: TAIL_LIMIT }), 'tail').autoPages).toBe(0)
  })

  it('asks for the next older page at the loaded row count', () => {
    expect(olderQuery(windowOf([101, 110, 120]))).toEqual({ limit: FIRST_PAGE_LIMIT, offset: 3, order: 'latest' })
    expect(olderQuery(emptyWindow())).toEqual({ limit: FIRST_PAGE_LIMIT, offset: 0, order: 'latest' })
  })

  it('asks for the tail from the newest end', () => {
    expect(tailQuery(0)).toEqual({ limit: TAIL_LIMIT, offset: 0, order: 'latest' })
    expect(tailQuery(TAIL_LIMIT)).toEqual({ limit: TAIL_LIMIT, offset: 50, order: 'latest' })
  })

  it('stops the tail on an overlapping or short page, and continues on a full disjoint one', () => {
    const loaded = windowOf([101, 110, 120])

    // Ids are not contiguous, so overlap is "any row id at or below the newest loaded id".
    expect(tailOverlaps(loaded, page([row(120), row(131)], { limit: TAIL_LIMIT, returned: 2 }))).toBe(true)
    expect(tailOverlaps(loaded, page([row(119)], { limit: TAIL_LIMIT, returned: 1 }))).toBe(true)

    const full = page(Array.from({ length: TAIL_LIMIT }, (_, i) => row(200 + i)), { limit: TAIL_LIMIT, returned: TAIL_LIMIT })
    expect(tailOverlaps(loaded, full)).toBe(false)

    // A short page means the route ran out of rows: there is nothing further back to ask for.
    expect(tailOverlaps(loaded, page([row(200)], { limit: TAIL_LIMIT, returned: 1 }))).toBe(true)

    // Nothing loaded yet: the first tail page cannot overlap.
    expect(tailOverlaps(emptyWindow(), full)).toBe(false)
  })

  it('auto-pages backward only while loaded, short of the start and inside the budget', () => {
    let w = windowOf([101, 110, 120])
    expect(canAutoPageOlder(w)).toBe(true)
    expect(canAutoPageOlder(emptyWindow())).toBe(false)
    expect(canAutoPageOlder({ ...w, reachedStart: true })).toBe(false)

    for (let i = 0; i < AUTO_PAGE_BUDGET; i += 1) {
      expect(canAutoPageOlder(w)).toBe(true)
      w = mergePage(w, page([row(50 - i)], { limit: 1, returned: 1 }), 'older')
    }
    expect(w.autoPages).toBe(AUTO_PAGE_BUDGET)
    expect(canAutoPageOlder(w)).toBe(false)
  })

  it('matches a binding only when every field still holds', () => {
    expect(sameBinding(binding, { ...binding })).toBe(true)
    expect(sameBinding(binding, { ...binding, connectionId: 'other' })).toBe(false)
    expect(sameBinding(binding, { ...binding, profile: 'kevin' })).toBe(false)
    expect(sameBinding(binding, { ...binding, liveSessionId: 'live-2' })).toBe(false)
    expect(sameBinding(binding, { ...binding, liveSessionId: null })).toBe(false)
    expect(sameBinding(binding, { ...binding, epoch: 'epoch-2' })).toBe(false)
    expect(sameBinding(binding, { ...binding, revision: 4 })).toBe(false)
  })

  it('names what a page reconciles: message_agent tool calls and receipt process ids', () => {
    const recorded = normalizeTranscriptPage(senderPageRaw as never)
    const ids = reconciledIds(recorded)

    // The recorded transcript's six `message_agent` results, and no other tool row.
    expect(ids.toolCallIds).toEqual([
      'call_Nfx9qJkrcOBUSpNkVll8VCEm',
      'call_W7BH7HW4zAEwvNbj4kNYzWUh',
      'call_B0fvHiZUchl0fdsEWOqZbJfA',
      'call_pJm7ALPH5a9L1p3dfWebcHV4',
      'call_nRwha9TQ0oE9AugWq67WcB4K',
      'call_QZXUy0W80yGtyEPZwlzOFkxc'
    ])
  })

  it('reconciles a tool result row whose tool_name did not survive, through its send row', () => {
    const send = row(10, { role: 'assistant', text: '', content: '', toolCalls: [{ id: 'call_r', name: 'message_agent', args: { target: 'zed', message: 'hi' } }] })
    const result = row(11, { role: 'tool', text: '{"status":"sent"}', content: '{"status":"sent"}', toolCallId: 'call_r' })
    const other = row(12, { role: 'tool', text: '{}', content: '{}', toolCallId: 'call_other', toolName: 'terminal' })
    expect(reconciledIds(page([send, result, other])).toolCallIds).toEqual(['call_r'])
  })
})
