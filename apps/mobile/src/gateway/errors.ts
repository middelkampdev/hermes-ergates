/**
 * Error categories for everything that crosses the gateway port.
 * Messages shown to the user never contain tokens, tickets or URLs.
 */

import { allowsPlainHttp, PUBLIC_HTTP_REFUSAL, usesHttps } from './address'

export type GatewayErrorKind =
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'rate_limited'
  | 'busy'
  | 'network'
  | 'timeout'
  | 'rpc'
  | 'unknown'

export class GatewayError extends Error {
  readonly kind: GatewayErrorKind
  /** A JSON-RPC or socket close code, or the error code of an Ergates route (`invalid`, `not_found`, ...). */
  readonly code?: number | string
  readonly status?: number
  readonly data?: unknown

  constructor(kind: GatewayErrorKind, message: string, extra: { code?: number | string; status?: number; data?: unknown; cause?: unknown } = {}) {
    super(message, extra.cause !== undefined ? { cause: extra.cause } : undefined)
    this.name = 'GatewayError'
    this.kind = kind
    this.code = extra.code
    this.status = extra.status
    this.data = extra.data
  }
}

export function isGatewayError(value: unknown): value is GatewayError {
  return value instanceof GatewayError
}

/**
 * A request or socket the app does not send: plain `http` to an address that may be on the public internet.
 * The message is plain text for the user, like `userMessage`.
 */
export class InsecureTransportError extends Error {
  constructor() {
    super(PUBLIC_HTTP_REFUSAL)
    this.name = 'InsecureTransportError'
  }
}

/**
 * Throws before a request or a socket leaves the phone for a public address over plain `http`. The screens
 * grade an address before they sign in, but a connection saved before that, or a path that skipped the
 * grade, must not send a password or a token in plain text either.
 */
export function requireSecureTransport(baseUrl: string): void {
  if (!usesHttps(baseUrl) && !allowsPlainHttp(baseUrl)) {
    throw new InsecureTransportError()
  }
}

const SECRET_PATTERN = /(token|ticket|cookie|password|secret|hermes_session_at|hermes_session_rt|hermes_session_provider)=[^&\s;]*/gi

/** Strip query-style secrets from any diagnostic text before it is stored or shown. */
export function redact(text: string): string {
  return text.replace(SECRET_PATTERN, '$1=<redacted>')
}

function bodyMessage(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') {
    return typeof body === 'string' && body.trim() ? body.slice(0, 200) : undefined
  }
  const record = body as Record<string, unknown>
  const detail = record.detail ?? record.error ?? record.message
  return typeof detail === 'string' ? detail.slice(0, 200) : undefined
}

export function mapHttpError(status: number, body?: unknown): GatewayError {
  const detail = bodyMessage(body)
  const extra = { status, data: body }
  switch (status) {
    case 401:
      return new GatewayError('unauthorized', 'Sign-in required.', extra)
    case 403:
      return new GatewayError('forbidden', detail ?? 'The gateway refused this request.', extra)
    case 404:
      return new GatewayError('not_found', detail ?? 'Not found.', extra)
    case 429:
      return new GatewayError('rate_limited', 'Too many attempts. Wait a moment and try again.', extra)
    default:
      if (status >= 500) {
        return new GatewayError('unknown', detail ?? 'The gateway had an internal problem.', extra)
      }
      return new GatewayError('unknown', detail ?? `Request failed (${status}).`, extra)
  }
}

/**
 * An error answer of an Ergates route: `{"error": {"code", "message"}}`. The
 * kind follows the HTTP status, as for any route; `code` is the Ergates error
 * code and the message is the server's safe text. An answer without that body (a 401 from Hermes's own auth middleware, a 404
 * from a gateway without the plugin) maps like any HTTP error, with no code.
 */
export function mapErgatesError(status: number, body: unknown): GatewayError {
  const base = mapHttpError(status, body)
  const error = body && typeof body === 'object' ? (body as { error?: unknown }).error : undefined
  const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined
  if (typeof code !== 'string' || !code) {
    return base
  }
  const message = (error as { message?: unknown }).message
  const text = typeof message === 'string' && message ? redact(message.slice(0, 200)) : base.message
  return new GatewayError(base.kind, text, { status, code, data: body })
}

// 4090/4091 are the session-slot and hosted-room refusals; 4009 is the backend's
// "session busy / disconnect interrupt settling" code (methods_prompt.py:768,
// session_lifecycle.py:825).
const BUSY_CODES = new Set([4009, 4090, 4091])
// 4007 is "session not found" (methods_session.py:829, session_lifecycle.py:823).
const NOT_FOUND_CODES = new Set([4007])
// 4001 means the same only with exactly this message: every session-scoped RPC
// on a runtime id Hermes no longer holds (a `hermes serve` restart, a reap)
// answers it (`_sess_nowait`, server.py:1229-1245). Any other 4001 is an
// unrelated validation failure (methods_complete.py:384,
// methods_config_set.py:162, methods_tools.py:151), so the bare code never maps.
const STALE_SESSION_CODE = 4001
const STALE_SESSION_MESSAGE = /^session not found$/i

function isNotFound(code: number, message: string): boolean {
  return NOT_FOUND_CODES.has(code) || (code === STALE_SESSION_CODE && STALE_SESSION_MESSAGE.test(message))
}

/** Map a rejection from the vendored JSON-RPC client (or any thrown value). */
export function mapRpcError(err: unknown): GatewayError {
  if (isGatewayError(err)) {
    return err
  }
  const anyErr = err as { name?: string; message?: string; code?: unknown; data?: unknown }
  const message = typeof anyErr?.message === 'string' ? anyErr.message : String(err)
  const code = typeof anyErr?.code === 'number' ? anyErr.code : undefined

  if (anyErr?.name === 'JsonRpcGatewayError' || code !== undefined) {
    if (code !== undefined && BUSY_CODES.has(code)) {
      return new GatewayError('busy', 'The assistant is busy with another turn.', { code, data: anyErr.data, cause: err })
    }
    if (code !== undefined && isNotFound(code, message)) {
      return new GatewayError('not_found', redact(message), { code, data: anyErr.data, cause: err })
    }
    return new GatewayError('rpc', redact(message), { code, data: anyErr.data, cause: err })
  }
  if (/timed out/i.test(message)) {
    return new GatewayError('timeout', 'The gateway did not answer in time.', { cause: err })
  }
  if (anyErr?.name === 'AbortError') {
    return new GatewayError('timeout', 'The request was cancelled.', { cause: err })
  }
  if (/WebSocket|not connected|network|Failed to fetch|closed/i.test(message)) {
    return new GatewayError('network', 'No connection to the gateway.', { cause: err })
  }
  return new GatewayError('unknown', redact(message), { cause: err })
}

/**
 * What answering a server request did: `sent` put the response frame on the
 * socket, `offline` sent nothing because the socket is down (Hermes keeps the
 * request for the reconnect), `unknown` sent nothing because the connection
 * holds no open request with that id.
 */
export type RespondOutcome = 'sent' | 'offline' | 'unknown'

/** Rejects unless the answer went out. */
export function requireSent(outcome: RespondOutcome): void {
  if (outcome === 'offline') {
    throw new GatewayError('network', 'No connection to the gateway.')
  }
  if (outcome === 'unknown') {
    throw new GatewayError('not_found', 'Hermes no longer waits for this answer.')
  }
}

export function mapSocketClose(code: number, reason = ''): GatewayError {
  switch (code) {
    case 4401:
      return new GatewayError('unauthorized', 'The gateway rejected the socket credential.', { code })
    case 4403:
      return new GatewayError('forbidden', 'The gateway refused this host or origin.', { code, data: redact(reason) })
    case 4404:
      return new GatewayError('forbidden', 'Chat is disabled on this gateway.', { code })
    default:
      return new GatewayError('network', 'The connection closed.', { code, data: redact(reason) })
  }
}

/** Short, plain sentence for the UI. */
export function userMessage(err: unknown): string {
  if (err instanceof InsecureTransportError) {
    return err.message
  }
  const mapped = isGatewayError(err) ? err : mapRpcError(err)
  switch (mapped.kind) {
    case 'unauthorized':
      return 'Sign-in required.'
    case 'forbidden':
      return 'The gateway refused this request.'
    case 'not_found':
      return 'Not found on the gateway.'
    case 'rate_limited':
      return 'Too many attempts. Wait a moment and try again.'
    case 'busy':
      return 'The assistant is busy with another turn.'
    case 'network':
      return 'No connection to the gateway.'
    case 'timeout':
      return 'The gateway did not answer in time.'
    default:
      return redact(mapped.message || 'Something went wrong.')
  }
}
