/**
 * Reconnect resynchronisation for one bound session.
 *
 * A WebSocket disconnect parks the session's transport on a drop sink
 * (`_detached_ws_transport`, tui_gateway/server.py:235), and exactly
 * three RPCs rebind it: `session.resume`'s reuse-live branch, `session.activate`
 * and `prompt.submit`. `session.events.since` reads an in-process ring and needs
 * no transport, so replaying alone leaves the socket open and silent: every later
 * delta, completion, clarify and approval for the open chat goes to the sink.
 *
 * So every reconnect runs `session.activate` FIRST and only then replays the
 * gap. Activate rebinds the transport, and the connection re-delivers the
 * server requests its `open_requests` lists before the call resolves
 * (json-rpc-channel.ts:474-483).
 *
 * Pure adapter logic: no React, no React Native (ADR-029 rule 1).
 */

import { isGatewayError, userMessage } from '@/gateway/errors'
import type { GatewayConnection, GatewayPort } from '@/gateway/port'
import type { ActivateResult } from '@/gateway/types'

import type { SessionAction } from './session-reducer'

/** `4009 session disconnect interrupt settling`: the reap timer is still polling. */
export const SETTLING_CODE = 4009
export const SETTLING_RETRY_MS = 500

/**
 * Backoff for a failed durable history refetch. The request is the recovery a
 * truncated replay or an epoch change asked for, so the flag stays raised until
 * one succeeds — which means the retry must be paced or the effect spins.
 */
export const HISTORY_BACKOFF_MS = [2_000, 5_000, 10_000]

/**
 * How many times a refetch re-reads immediately when the snapshot it got back
 * was already stale (something settled while it was in flight, spec 5.8). After
 * these rounds the refetch fails and the backoff above takes over, so a chat
 * that keeps changing cannot spin the fetch loop.
 */
export const HISTORY_STALE_ROUNDS = 3

export function historyRetryDelayMs(attempt: number): number {
  const index = Math.min(Math.max(attempt, 0), HISTORY_BACKOFF_MS.length - 1)
  return HISTORY_BACKOFF_MS[index] ?? 10_000
}

const sleepDefault = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

function isSettling(err: unknown): boolean {
  if (!isGatewayError(err)) {
    return false
  }
  return err.code === SETTLING_CODE || /settling/i.test(err.message)
}

/** The session id the gateway knows is gone; a resync cannot fix it, only a re-open. */
function isStale(err: unknown): boolean {
  return isGatewayError(err) && err.kind === 'not_found'
}

/**
 * `session.activate`, retried once after a short delay when the gateway is still
 * settling a client-gone interrupt. `onSend` runs right before each call goes out.
 */
export async function activateSession(
  port: GatewayPort,
  liveSessionId: string,
  sleep: (ms: number) => Promise<void> = sleepDefault,
  onSend: () => void = () => undefined
): Promise<ActivateResult> {
  const send = (): Promise<ActivateResult> => {
    onSend()
    return port.sessions.activate(liveSessionId, { omit_messages: true })
  }
  try {
    return await send()
  } catch (err) {
    if (!isSettling(err)) {
      throw err
    }
    await sleep(SETTLING_RETRY_MS)
    return send()
  }
}

export interface ResyncOptions {
  port: GatewayPort
  connection: GatewayConnection
  liveSessionId: string
  /** Read at call time: the watermark may have advanced while activate was in flight. */
  lastSeq: () => number
  /**
   * The request ids of the cards still pending, read right before activate goes out. Only
   * those may expire when its snapshot leaves them out (`session/activated`).
   */
  pendingRequestIds: () => readonly string[]
  dispatch: (action: SessionAction) => void
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

export interface ResyncResult {
  activated: boolean
  replayed: boolean
  /** The gateway no longer knows this session id: the caller must re-open the chat. */
  stale: boolean
  /** UI-safe message when something failed. */
  error?: string
}

/**
 * Rebind the transport, fold the reconnect-time snapshot (open requests, inflight
 * turn, run status), then replay the event gap.
 */
export async function resyncSession(options: ResyncOptions): Promise<ResyncResult> {
  const { port, connection, liveSessionId, lastSeq, dispatch } = options
  const at = (options.now ?? Date.now)()
  const result: ResyncResult = { activated: false, replayed: false, stale: false }

  try {
    let pendingWhenSent: readonly string[] = []
    const activated = await activateSession(port, liveSessionId, options.sleep, () => {
      pendingWhenSent = options.pendingRequestIds()
    })
    result.activated = true
    dispatch({ type: 'session/activated', result: activated, at, pendingWhenSent })
  } catch (err) {
    result.stale = isStale(err)
    result.error = userMessage(err)
    // A failed activate still leaves the ring readable: replay what we can rather
    // than leaving the transcript with a hole.
  }

  try {
    const replay = await connection.replay(liveSessionId, lastSeq())
    dispatch({ type: 'replay/result', result: replay })
    result.replayed = true
  } catch (err) {
    result.error = result.error ?? userMessage(err)
  }
  return result
}
