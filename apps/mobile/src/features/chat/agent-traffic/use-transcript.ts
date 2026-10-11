/**
 * useTranscriptWindow: the REST transcript window for one chat, and the fetch
 * scheduling spec 5.8 asks for.
 *
 * React adapter (ADR-029 rule 2): every rule it applies lives in `window.ts` and
 * `exchange.ts`, which are pure and tested in Node — this file only holds the
 * Query, the refs and the effects. The window is memory-only, in the TanStack
 * cache, never persisted (ADR-028), and nothing here calls `prompt.submit`
 * (ADR-027).
 *
 * Scheduling, all of it event-driven (no timer anywhere):
 *  - the first page is the Query's own `queryFn`;
 *  - every `tailWanted` bump (a local turn completing, a `status.update
 *    {kind:"process"}`, a `message_agent` completion) runs one tail, continuing
 *    backward until it reaches the rows already loaded;
 *  - evidence that must be older (a receipt without its send, a tool row without
 *    its assistant row) pages backward under the four-page budget;
 *  - returning to the foreground re-runs the tail once;
 *  - a failed fetch writes its message into the window and waits for the next
 *    trigger — it never retries on its own.
 */

import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AppState, type AppStateStatus } from 'react-native'

import { GatewayError, userMessage } from '@/gateway/errors'
import type { GatewayPort } from '@/gateway/port'
import type { TranscriptPage } from '@/gateway/types'

import type { ChatItem } from '../history'

import { buildExchanges, collectEvidence } from './exchange'
import type { RosterPeer } from './types'
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
  type PageKind,
  type TranscriptWindow
} from './window'

/** The window is cheap to rebuild and must not outlive a chat the user left (ADR-028). */
export const TRANSCRIPT_GC_MS = 5 * 60_000
/** Immediate re-reads when the first page came back already stale, before giving up (spec 5.8). */
const STALE_ROUNDS = 3
/** No tail has run yet for any `tailWanted`; `tailWanted` itself starts at 0. */
const NO_TAIL_HANDLED = -1
/** How many fetches a manual "Older messages" tap waits out: one full tail run, plus slack. */
const MANUAL_WAIT_ROUNDS = AUTO_PAGE_BUDGET + 2

export const transcriptKey = (connectionId: string, storedSessionId: string) => ['transcript', connectionId, storedSessionId] as const

export interface TranscriptController {
  window: TranscriptWindow
  /** "Older messages": one page further back, without the automatic budget. */
  loadOlder(): Promise<void>
  status: 'idle' | 'loading' | 'error'
}

export interface UseTranscriptOptions {
  enabled: boolean
  connectionId: string
  profile: string
  /** The durable session the REST route reads; the window is keyed on it. */
  storedSessionId: string | null
  liveSessionId: string | null
  epoch: string | null
  revision: number
  tailWanted: number
  /** Live chat items: half the evidence `needsOlder` is decided from (spec 5.5). */
  items: ChatItem[]
  roster: RosterPeer[]
  /** A merged page made these live observations durable (spec 5.8). */
  onReconciled: (ids: { toolCallIds: string[] }) => void
}

type FetchOutcome = { status: 'ok'; page: TranscriptPage } | { status: 'skipped' } | { status: 'stale' } | { status: 'error' }

export function useTranscriptWindow(port: GatewayPort, opts: UseTranscriptOptions): TranscriptController {
  const queryClient = useQueryClient()
  const { connectionId, profile, storedSessionId, liveSessionId, epoch, revision, tailWanted, items, roster } = opts
  const enabled = opts.enabled && storedSessionId !== null
  const key = useMemo(() => transcriptKey(connectionId, storedSessionId ?? ''), [connectionId, storedSessionId])

  // What a fetch in flight must read when it COMPLETES, not when it started.
  const bindingRef = useRef<FetchBinding>({ connectionId, profile, liveSessionId, epoch, revision })
  bindingRef.current = { connectionId, profile, liveSessionId, epoch, revision }
  const sessionRef = useRef<string | null>(storedSessionId)
  sessionRef.current = storedSessionId
  const keyRef = useRef(key)
  keyRef.current = key
  const onReconciledRef = useRef(opts.onReconciled)
  onReconciledRef.current = opts.onReconciled

  /** One fetch in flight (spec 5.8). */
  const inFlightRef = useRef(false)
  /** Settles when the fetch in flight is done, so a manual tap can wait it out. */
  const inFlightDoneRef = useRef<Promise<void> | null>(null)
  /** The `tailWanted` the last tail run answered. */
  const handledTailRef = useRef(NO_TAIL_HANDLED)
  /** The first page has landed once; the triggers it already covers are not owed a tail. */
  const firstPageAdoptedRef = useRef(false)
  /** The `tailWanted` the first page was ISSUED at: only those triggers are covered by it. */
  const firstPageTailRef = useRef(NO_TAIL_HANDLED)
  /** `tailWanted` as of the current render, readable from inside the `queryFn`. */
  const tailWantedRef = useRef(tailWanted)
  tailWantedRef.current = tailWanted
  /**
   * The last automatic fetch failed: wait for the next trigger listed above instead of retrying, so a
   * broken route is not fetched again in a loop.
   */
  const blockedRef = useRef(false)
  /** How many tail pages this trigger has had discarded as stale. */
  const staleTailRef = useRef({ wanted: NO_TAIL_HANDLED, rounds: 0 })
  /** How many backward pages in a row were discarded as stale. */
  const staleOlderRef = useRef(0)
  const [fetching, setFetching] = useState(false)
  /** Bumped when a page was discarded, so the effects run again (spec 5.8). */
  const [retryNonce, setRetryNonce] = useState(0)

  /** A new trigger lifts the "the last automatic fetch got nowhere" latch. */
  const clearAutoBlock = useCallback((): void => {
    blockedRef.current = false
    staleOlderRef.current = 0
  }, [])

  /** Claims the single fetch slot; the returned function releases it. */
  const claim = useCallback((): (() => void) => {
    inFlightRef.current = true
    setFetching(true)
    let settle = (): void => {}
    inFlightDoneRef.current = new Promise<void>(resolve => {
      settle = resolve
    })
    return () => {
      inFlightRef.current = false
      inFlightDoneRef.current = null
      setFetching(false)
      settle()
    }
  }, [])

  const fetchPage = useCallback(
    async (sessionId: string, query: { limit: number; offset: number; order: 'latest' }): Promise<TranscriptPage> =>
      port.sessions.transcript(sessionId, { profile: bindingRef.current.profile, ...query }),
    [port]
  )

  const query = useQuery({
    queryKey: key,
    // The key carries the stored session id, and the Query only runs when there is
    // one, so the first page never has to guess which chat it is reading.
    queryFn: async ({ queryKey }): Promise<TranscriptWindow> => {
      const release = claim()
      // What this page will be able to account for once it lands (see the adoption below).
      firstPageTailRef.current = tailWantedRef.current
      try {
        for (let round = 0; round < STALE_ROUNDS; round += 1) {
          const captured = bindingRef.current
          const page = await fetchPage(queryKey[2], { limit: FIRST_PAGE_LIMIT, offset: 0, order: 'latest' })
          if (!sameBinding(captured, bindingRef.current)) {
            continue
          }
          onReconciledRef.current(reconciledIds(page))
          return mergePage(emptyWindow(), page, 'initial')
        }
        // Three first pages in a row belonged to a chat or a revision that had
        // already moved on. Fail visibly; the next trigger re-reads.
        throw new GatewayError('unknown', 'The transcript kept changing while it loaded.')
      } finally {
        release()
      }
    },
    staleTime: Infinity,
    gcTime: TRANSCRIPT_GC_MS,
    retry: false,
    enabled
  })
  const { data, error, isError, isFetching, refetch } = query

  const loadedWindow = useMemo<TranscriptWindow>(() => {
    const base = data ?? emptyWindow()
    return error ? { ...base, error: userMessage(error) } : base
  }, [data, error])

  /**
   * One page, merged into the window. A page whose binding no longer holds is
   * dropped and the effects are woken; a failure is written into the window and
   * waits for the next trigger.
   */
  const runFetch = useCallback(
    async (kind: PageKind, query: { limit: number; offset: number; order: 'latest' }, merge: { manual?: boolean } = {}): Promise<FetchOutcome> => {
      const sessionId = sessionRef.current
      if (sessionId === null || inFlightRef.current) {
        return { status: 'skipped' }
      }
      const release = claim()
      const captured = bindingRef.current
      const target = keyRef.current
      try {
        const page = await fetchPage(sessionId, query)
        if (!sameBinding(captured, bindingRef.current)) {
          setRetryNonce(n => n + 1)
          return { status: 'stale' }
        }
        queryClient.setQueryData<TranscriptWindow>(target, current => mergePage(current ?? emptyWindow(), page, kind, merge))
        // A page landed: whatever the last failure or discard was, progress was made.
        clearAutoBlock()
        onReconciledRef.current(reconciledIds(page))
        return { status: 'ok', page }
      } catch (err) {
        queryClient.setQueryData<TranscriptWindow>(target, current => ({ ...(current ?? emptyWindow()), error: userMessage(err) }))
        blockedRef.current = true
        return { status: 'error' }
      } finally {
        release()
      }
    },
    [claim, clearAutoBlock, fetchPage, queryClient]
  )

  /**
   * One tail run: the newest page, then one page further back at a time until it
   * reaches the rows this window already held. The boundary is the window as it
   * was BEFORE the run — after the first page merges, its own newest row is the
   * window's newest, and every later page would look like an overlap.
   */
  const runTail = useCallback(
    async (wanted: number): Promise<void> => {
      handledTailRef.current = wanted
      const boundary = queryClient.getQueryData<TranscriptWindow>(keyRef.current) ?? emptyWindow()
      let offset = 0
      for (let pages = 0; pages < AUTO_PAGE_BUDGET; pages += 1) {
        const outcome = await runFetch('tail', tailQuery(offset))
        if (outcome.status === 'skipped') {
          // Another fetch owns the wire; its merge runs this effect again for the
          // same trigger.
          handledTailRef.current = NO_TAIL_HANDLED
          return
        }
        if (outcome.status === 'stale') {
          // The page no longer belongs to this chat or revision. Read again — but
          // a chat that keeps settling must not spin the gateway, so after three
          // rounds this trigger is given up and the next one re-reads.
          const previous = staleTailRef.current
          const rounds = previous.wanted === wanted ? previous.rounds + 1 : 1
          staleTailRef.current = { wanted, rounds }
          handledTailRef.current = rounds >= STALE_ROUNDS ? wanted : NO_TAIL_HANDLED
          return
        }
        if (outcome.status === 'error' || tailOverlaps(boundary, outcome.page)) {
          return
        }
        offset += TAIL_LIMIT
      }
    },
    [queryClient, runFetch]
  )

  // A new chat gets a new window: nothing the previous one scheduled applies.
  useEffect(() => {
    handledTailRef.current = NO_TAIL_HANDLED
    firstPageAdoptedRef.current = false
    clearAutoBlock()
  }, [connectionId, storedSessionId, clearAutoBlock])

  // (a) Every tail trigger, and the re-read of a first page that failed.
  useEffect(() => {
    if (!enabled || handledTailRef.current === tailWanted) {
      return
    }
    if (!loadedWindow.loaded) {
      if (isError && !isFetching) {
        handledTailRef.current = tailWanted
        clearAutoBlock()
        void refetch()
      }
      return
    }
    if (!firstPageAdoptedRef.current) {
      // The first page is the newest 500 rows: it carries every trigger that had fired when it was
      // ISSUED, and only those. A turn that completed while it was in flight is not in it, so that
      // bump still gets its 50-row tail.
      firstPageAdoptedRef.current = true
      handledTailRef.current = firstPageTailRef.current
      if (handledTailRef.current === tailWanted) {
        return
      }
    }
    clearAutoBlock()
    void runTail(tailWanted)
    // `retryNonce` is a wake-up signal for a discarded page, not a value this
    // effect reads (spec 5.8).
  }, [enabled, loadedWindow, tailWanted, retryNonce, runTail, refetch, isError, isFetching, clearAutoBlock])

  // (b) Evidence that must be older than the loaded window (spec 5.5).
  const needsOlder = useMemo(
    () => buildExchanges(collectEvidence(items, loadedWindow.rows), { roster, window: loadedWindow }).needsOlder,
    [items, loadedWindow, roster]
  )

  useEffect(() => {
    if (!enabled || !needsOlder || blockedRef.current || !canAutoPageOlder(loadedWindow)) {
      return
    }
    void (async () => {
      const outcome = await runFetch('older', olderQuery(loadedWindow))
      if (outcome.status !== 'stale') {
        return
      }
      // A discarded backward page changes nothing this effect watches — not the
      // window, not `needsOlder`, not the budget — so without a bound the retry
      // nonce would re-issue the same 500-row fetch on every discard. Three
      // rounds, then the latch the error path uses, lifted by the next trigger.
      staleOlderRef.current += 1
      if (staleOlderRef.current >= STALE_ROUNDS) {
        blockedRef.current = true
      }
    })()
  }, [enabled, needsOlder, loadedWindow, retryNonce, runFetch])

  // (d) iOS suspends the socket within seconds: whatever happened while the app
  // was away is read once, through the same tail path.
  useEffect(() => {
    const onChange = (status: AppStateStatus): void => {
      if (status !== 'active' || !enabled) {
        return
      }
      handledTailRef.current = NO_TAIL_HANDLED
      clearAutoBlock()
      setRetryNonce(n => n + 1)
    }
    const sub = AppState.addEventListener('change', onChange)
    return () => sub.remove()
  }, [enabled, clearAutoBlock])

  /**
   * A tap must never be swallowed because the wire was busy: wait out the fetch in
   * flight and try again, bounded by the pages one tail run can take, so a chat
   * that keeps fetching cannot hold the tap open forever. Exhausting the attempts
   * is reported the way a failure is, through `status`.
   */
  const loadOlder = useCallback(async (): Promise<void> => {
    clearAutoBlock()
    for (let attempt = 0; attempt < MANUAL_WAIT_ROUNDS; attempt += 1) {
      const inFlight = inFlightDoneRef.current
      if (inFlight) {
        await inFlight
        continue
      }
      const current = queryClient.getQueryData<TranscriptWindow>(keyRef.current) ?? emptyWindow()
      if (!current.loaded || current.reachedStart) {
        return
      }
      const outcome = await runFetch('older', olderQuery(current), { manual: true })
      // 'skipped': another fetch owns the wire. 'stale': the page was discarded because the chat
      // settled while it was in flight. Both mean the tap got nothing — wait and try again rather
      // than leave the user with an unchanged screen and no message.
      if (outcome.status !== 'skipped' && outcome.status !== 'stale') {
        return
      }
    }
    queryClient.setQueryData<TranscriptWindow>(keyRef.current, current => ({ ...(current ?? emptyWindow()), error: 'Older messages could not be loaded.' }))
  }, [clearAutoBlock, queryClient, runFetch])

  // A retry in flight reads as loading, not as the error it is retrying.
  const status: TranscriptController['status'] = isFetching || fetching ? 'loading' : loadedWindow.error !== null ? 'error' : 'idle'

  return useMemo(() => ({ window: loadedWindow, loadOlder, status }), [loadedWindow, loadOlder, status])
}
