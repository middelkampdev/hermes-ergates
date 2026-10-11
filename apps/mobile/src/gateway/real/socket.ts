/**
 * One socket per (connection, profile), wrapping the vendored
 * JsonRpcGatewayClient. Adds: wait-for-ready, fresh credential on every
 * (re)connect, bounded reconnect backoff, close-code mapping, error mapping,
 * and the open server requests Hermes waits on. The vendored client replays
 * per-session watermarks itself, re-delivers `open_requests`, and tells
 * Hermes once per socket that it answers server requests
 * (json-rpc-channel.ts:489-492, 508-518).
 */

import type { ServerRequest } from '@vendor/hermes/shared/json-rpc-channel'
import { JsonRpcGatewayClient, type ConnectionState as ClientState, type GatewayEvent, type WebSocketLike } from '@vendor/hermes/shared/json-rpc-gateway'

import { GatewayError, mapRpcError, mapSocketClose, userMessage, type RespondOutcome } from '../errors'
import type { ConnectionFailure, ConnectionState, GatewayConnection } from '../port'
import type { GatewayEventFrame, GatewayReadyPayload, ReplayResult, ServerRequestFrame } from '../types'
import { buildSocketUrl } from './auth'

export interface SocketCredential {
  token?: string
  ticket?: string
}

export interface SocketSessionOptions {
  baseUrl: string
  profile: string
  /** Called before every connect; gated mode must mint a fresh ticket. */
  credential: () => Promise<SocketCredential>
  socketFactory?: (url: string) => WebSocketLike
  readyTimeoutMs?: number
  /** Backoff schedule in ms; the last value repeats. */
  backoffMs?: number[]
  now?: () => number
  /**
   * Called once when this session fails terminally (an authentication or guard
   * close, or a credential that no longer authenticates). `RealGateway` evicts
   * the socket from its cache so a re-login rebuilds it instead of handing out
   * the same dead promise forever.
   */
  onTerminal?: (error: GatewayError) => void
}

/** Is this failure one that reconnecting cannot fix? */
function isTerminalKind(kind: GatewayError['kind']): boolean {
  return kind === 'unauthorized' || kind === 'forbidden'
}

function toFailure(error: GatewayError, terminal: boolean): ConnectionFailure {
  return { kind: error.kind, message: userMessage(error), terminal, code: error.code }
}

const DEFAULT_READY_TIMEOUT_MS = 15_000
const DEFAULT_BACKOFF = [1_000, 2_000, 5_000, 10_000]

/** The server requests the phone shows as a card. */
const CARD_METHODS = new Set(['approval', 'clarify'])
/** Requests only the Hermes Desktop window showing the chat can answer (tui_gateway/server_requests.py:24-28). */
const WINDOW_METHODS = new Set(['preview.act', 'preview.read', 'terminal.read', 'window.read', 'tour'])
const NOT_SHOWN_MESSAGE = 'This phone shows no preview, terminal, window or tour.'

export class SocketSession implements GatewayConnection {
  readonly profile: string
  ready: GatewayReadyPayload = {}
  private readonly client: JsonRpcGatewayClient
  private readonly options: SocketSessionOptions
  private stateValue: ConnectionState = 'connecting'
  private readonly stateHandlers = new Set<(state: ConnectionState) => void>()
  private closedByUser = false
  private reconnectAttempt = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  /** Set by the close handler of the dial currently in flight; cleared when a dial starts. */
  private lastCloseError: GatewayError | null = null
  /** The most recent failure (close or dial), kept for the UI after the fact. */
  private lastFailure: GatewayError | null = null
  /** Non-null once this session is beyond repair without a new credential. */
  private terminalError: GatewayError | null = null
  private terminalReported = false
  /** The approval and clarify requests Hermes still waits on, by id. */
  private readonly openRequests = new Map<string, ServerRequest>()
  /** The ids answered on the current socket; a new socket starts with none. */
  private readonly answeredHere = new Set<string>()
  private readonly requestHandlers = new Set<(request: ServerRequestFrame) => void>()

  private constructor(options: SocketSessionOptions) {
    this.options = options
    this.profile = options.profile
    this.client = new JsonRpcGatewayClient({
      socketFactory: options.socketFactory,
      requestIdPrefix: 'm',
      onSocketClose: event => {
        const code = (event as { code?: number })?.code ?? 0
        if (code === 4401 || code === 4403 || code === 4404) {
          const error = mapSocketClose(code, (event as { reason?: string })?.reason ?? '')
          this.lastCloseError = error
          this.markTerminal(error)
        }
        return false
      }
    })
    this.client.onState(state => this.handleClientState(state))
    // Registered before the first dial, so the `open_requests` of the first
    // `session.resume` find a handler. It never returns false: the channel
    // would answer -32601, and Hermes withdraws an approval on any error
    // answer (server.py:833-846).
    this.client.onRequest(request => this.takeRequest(request))
    this.client.on('request.cancel', event => {
      const id = event.payload?.id
      if (typeof id === 'string') {
        this.openRequests.delete(id)
      }
    })
  }

  /**
   * Approval and clarify become cards. A window-owned request gets the 4404
   * decline, which settles only when every answering client declined
   * (server_requests.py:221-250). Everything else (sudo, secret, vault
   * prompts, setup_choose) stays unanswered: Hermes's own deadline ends it
   * (the one-string prompts then get an empty answer, server.py:1398-1404),
   * and a Hermes Desktop window on the same chat can still answer it first.
   */
  private takeRequest(request: ServerRequest): void {
    if (WINDOW_METHODS.has(request.method)) {
      request.decline?.(NOT_SHOWN_MESSAGE)
      return
    }
    if (!CARD_METHODS.has(request.method)) {
      return
    }
    // Hermes handles the frames of one socket in arrival order, and session.activate and
    // session.events.since run inline (server.py:181-196, rpc_dispatch.py:54-58). So an
    // `open_requests` snapshot that answers a call sent before our answer still lists the
    // id, and arrives after we answered. Hermes then sends no `request.cancel`
    // (server_requests.py:262-293): drop that delivery, or the card reopens and a second tap
    // shows a choice Hermes never applied. On a later socket the answer may have been lost
    // with the old one, so a delivery there counts.
    if (request.replayed === true && this.answeredHere.has(request.id)) {
      return
    }
    // A re-delivery after a reconnect reuses the id and replaces the entry.
    this.openRequests.set(request.id, request)
    const frame: ServerRequestFrame = { id: request.id, method: request.method, params: request.params, replayed: request.replayed === true }
    try {
      for (const handler of [...this.requestHandlers]) {
        handler(frame)
      }
    } catch (err) {
      // The channel answers -32603 for a throwing handler, so Hermes stops waiting: forget it too.
      this.openRequests.delete(request.id)
      throw err
    }
  }

  static async open(options: SocketSessionOptions): Promise<SocketSession> {
    const session = new SocketSession(options)
    await session.dial()
    return session
  }

  get state(): ConnectionState {
    return this.stateValue
  }

  /** The failure behind the most recent close or failed dial, in UI-safe form. */
  get lastError(): ConnectionFailure | null {
    const error = this.terminalError ?? this.lastFailure
    return error ? toFailure(error, this.terminalError !== null) : null
  }

  /** True when reconnecting cannot help: the owner must sign in again. */
  get terminal(): boolean {
    return this.terminalError !== null
  }

  /**
   * A ticket mint that returns 401/403, or an authentication/guard close, is the
   * end of the line for this socket: a re-dial would loop on a dead credential
   * every backoff tick. Record it, stop reconnecting, and let the owner
   * (`RealGateway`) drop this session so a re-login can build a fresh one.
   */
  private markTerminal(error: GatewayError): void {
    if (this.terminalError) {
      return
    }
    this.terminalError = error
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (!this.terminalReported) {
      this.terminalReported = true
      this.options.onTerminal?.(error)
    }
  }

  private async dial(): Promise<void> {
    // A stale close error must not be reported as the cause of a later network
    // drop, and must not keep scheduleReconnect() disarmed for the object's life.
    this.lastCloseError = null
    try {
      await this.dialOnce()
      // A recovered connection must not keep reporting the failure it recovered from.
      this.lastFailure = null
    } catch (err) {
      const mapped = err instanceof GatewayError ? err : mapRpcError(err)
      this.lastFailure = mapped
      if (isTerminalKind(mapped.kind)) {
        this.markTerminal(mapped)
        this.setState('error')
      }
      throw mapped
    }
  }

  private async dialOnce(): Promise<void> {
    const cred = await this.options.credential()
    const url = buildSocketUrl(this.options.baseUrl, this.options.profile, cred)
    const readyTimeout = this.options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS

    let offReady: () => void = () => undefined
    let offState: () => void = () => undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    const readyPromise = new Promise<GatewayReadyPayload>((resolve, reject) => {
      let settled = false
      const finish = (fn: () => void) => {
        if (settled) {
          return
        }
        settled = true
        offReady()
        offState()
        if (timer !== undefined) {
          clearTimeout(timer)
        }
        fn()
      }
      offReady = this.client.on('gateway.ready', event => finish(() => resolve((event.payload ?? {}) as GatewayReadyPayload)))
      timer = setTimeout(() => finish(() => reject(new GatewayError('timeout', 'The gateway did not announce readiness.'))), readyTimeout)
      // Subscribe after the handshake starts so the synchronous initial callback sees 'connecting'.
      queueMicrotask(() => {
        if (settled) {
          return
        }
        offState = this.client.onState(state => {
          if (state === 'closed' || state === 'error') {
            finish(() => reject(this.lastCloseError ?? new GatewayError('network', 'The connection closed before it was ready.')))
          }
        })
      })
    })
    // Keep the rejection observed even when connect() throws first.
    readyPromise.catch(() => undefined)

    try {
      // The vendored connect() only settles on open/error/timeout; a close before open must also end the dial.
      await Promise.race([this.client.connect(url), readyPromise.then(() => undefined)])
    } catch (err) {
      throw this.lastCloseError ?? (err instanceof GatewayError ? err : mapRpcError(err))
    }
    this.ready = await readyPromise
    this.reconnectAttempt = 0
  }

  private handleClientState(state: ClientState): void {
    if (state === 'idle') {
      return
    }
    const mapped: ConnectionState = state === 'open' ? 'open' : state === 'connecting' ? 'connecting' : state === 'error' ? 'error' : 'closed'
    if (state === 'open') {
      // A new socket: an answer sent on an older one no longer holds back a delivery.
      this.answeredHere.clear()
    }
    this.setState(mapped)
    if ((state === 'closed' || state === 'error') && !this.closedByUser) {
      this.scheduleReconnect()
    }
  }

  private setState(state: ConnectionState): void {
    if (this.stateValue === state) {
      return
    }
    this.stateValue = state
    for (const handler of this.stateHandlers) {
      handler(state)
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null || this.closedByUser) {
      return
    }
    // Authentication and guard failures are terminal: the owner must sign in again.
    if (this.terminalError) {
      this.setState('error')
      return
    }
    const schedule = this.options.backoffMs ?? DEFAULT_BACKOFF
    const delay = schedule[Math.min(this.reconnectAttempt, schedule.length - 1)] ?? 10_000
    this.reconnectAttempt += 1
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (this.closedByUser) {
        return
      }
      void this.dial().catch(() => {
        if (!this.closedByUser) {
          this.scheduleReconnect()
        }
      })
    }, delay)
  }

  /** Force an immediate reconnect attempt (app foregrounded). */
  async reconnectNow(): Promise<void> {
    if (this.closedByUser || this.terminalError || this.stateValue === 'open' || this.stateValue === 'connecting') {
      return
    }
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    await this.dial()
  }

  async request<R>(method: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<R> {
    try {
      return await this.client.request<R>(method, params, timeoutMs)
    } catch (err) {
      throw mapRpcError(err)
    }
  }

  onEvent(handler: (event: GatewayEventFrame) => void): () => void {
    return this.client.onAny((event: GatewayEvent) => handler(event as GatewayEventFrame))
  }

  onRequest(handler: (request: ServerRequestFrame) => void): () => void {
    this.requestHandlers.add(handler)
    return () => {
      this.requestHandlers.delete(handler)
    }
  }

  /**
   * Answer an open server request with one response frame. Checked first:
   * the vendored `respond` drops the frame on a socket that is down and still
   * counts the request as answered (json-rpc-channel.ts:355-367), so while
   * the socket is down nothing is sent and the request stays open.
   */
  respond(requestId: string, result: Record<string, unknown>): RespondOutcome {
    if (this.stateValue !== 'open') {
      return 'offline'
    }
    const request = this.openRequests.get(requestId)
    if (!request) {
      return 'unknown'
    }
    this.openRequests.delete(requestId)
    this.answeredHere.add(requestId)
    request.respond(result)
    return 'sent'
  }

  onState(handler: (state: ConnectionState) => void): () => void {
    this.stateHandlers.add(handler)
    handler(this.stateValue)
    return () => {
      this.stateHandlers.delete(handler)
    }
  }

  replay(sessionId: string, lastSeen: number): Promise<ReplayResult> {
    return this.request<ReplayResult>('session.events.since', { session_id: sessionId, last_seen: lastSeen }, 10_000)
  }

  close(): void {
    this.closedByUser = true
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.client.close()
    this.setState('closed')
  }
}
