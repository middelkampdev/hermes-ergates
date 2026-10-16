/**
 * HTTP client for `hermes serve` REST. Two auth modes:
 *  - token: loopback plain mode, header `X-Hermes-Session-Token`
 *  - password: gated mode, cookies captured from `Set-Cookie` and replayed
 *    explicitly as a `Cookie` header. The platform jar is off
 *    (`credentials: 'omit'`), so it never keeps a second copy of the sign-in.
 * Never sends a request to a public address over plain http (`InsecureTransportError`).
 * Never logs headers, bodies or full URLs.
 */

import { normalizeBaseUrl } from '../address'
import { GatewayError, mapHttpError, requireSecureTransport } from '../errors'

// The one normalizer lives in ../address; this keeps it importable from the HTTP client module.
export { normalizeBaseUrl }

export type HttpAuthMode = 'none' | 'token' | 'password'

export interface HttpAuthState {
  mode: HttpAuthMode
  token?: string | null
  cookie?: string | null
}

export interface HttpClientOptions {
  baseUrl: string
  getAuth: () => HttpAuthState
  onSetCookie?: (cookieHeader: string) => void
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

/** One HTTP answer, before any status mapping. */
export interface HttpExchange {
  status: number
  /** The JSON-decoded body, the raw text when it is not JSON, or undefined when empty. */
  body: unknown
}

export interface HttpRequestOptions {
  redirect?: RequestRedirect
  /** This request's timeout instead of the client default. */
  timeoutMs?: number
}

export const SESSION_TOKEN_HEADER = 'X-Hermes-Session-Token'
const DEFAULT_TIMEOUT_MS = 30_000

/** Merge `Set-Cookie` values into a `name=value; name2=value2` Cookie header string. */
export function mergeCookieHeader(existing: string | null | undefined, setCookie: string[]): string {
  const jar = new Map<string, string>()
  for (const part of (existing ?? '').split(';')) {
    const [name, ...rest] = part.trim().split('=')
    if (name && rest.length) {
      jar.set(name, rest.join('='))
    }
  }
  for (const raw of setCookie) {
    const first = raw.split(';')[0] ?? ''
    const [name, ...rest] = first.trim().split('=')
    if (!name) {
      continue
    }
    const value = rest.join('=')
    const attrs = raw.toLowerCase()
    if (/max-age=0(;|$)/.test(attrs) || value === '' || value === '""') {
      jar.delete(name)
    } else {
      jar.set(name, value)
    }
  }
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ')
}

/** Split a combined `set-cookie` header (React Native and undici join them with commas). */
export function splitSetCookie(header: string | null): string[] {
  if (!header) {
    return []
  }
  // Split on commas that start a new cookie (name=), not those inside Expires dates.
  return header.split(/,(?=\s*[A-Za-z0-9_\-!#$%&'*+.^`|~]+=)/).map(s => s.trim()).filter(Boolean)
}

export class HttpClient {
  readonly baseUrl: string
  private readonly getAuth: () => HttpAuthState
  private readonly onSetCookie?: (cookieHeader: string) => void
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number

  constructor(options: HttpClientOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl)
    this.getAuth = options.getAuth
    this.onSetCookie = options.onSetCookie
    this.fetchImpl = options.fetchImpl ?? fetch
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path)
  }

  post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('POST', path, body)
  }

  put<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('PUT', path, body)
  }

  patch<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('PATCH', path, body)
  }

  delete<T>(path: string): Promise<T> {
    return this.request<T>('DELETE', path)
  }

  async request<T>(method: string, path: string, body?: unknown, opts: HttpRequestOptions = {}): Promise<T> {
    const answer = await this.exchange(method, path, body, opts)
    // A manual redirect (302 after logout) counts as success.
    if (answer.status >= 300 && answer.status < 400) {
      return undefined as T
    }
    if (answer.status < 200 || answer.status >= 300) {
      throw mapHttpError(answer.status, answer.body)
    }
    return answer.body as T
  }

  /**
   * One request with auth, timeout, cookie capture and body parsing, but no
   * status mapping: the caller decides what each status means. Throws only
   * when there is no answer (network failure or timeout).
   */
  async exchange(method: string, path: string, body?: unknown, opts: HttpRequestOptions = {}): Promise<HttpExchange> {
    // Before the auth is read, so a password or token never gets as far as a header.
    requireSecureTransport(this.baseUrl)
    const auth = this.getAuth()
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json'
    }
    if (auth.mode === 'token' && auth.token) {
      headers[SESSION_TOKEN_HEADER] = auth.token
    }
    if (auth.mode === 'password' && auth.cookie) {
      headers.Cookie = auth.cookie
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? this.timeoutMs)
    let response: Response
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
        redirect: opts.redirect ?? 'manual',
        // The platform cookie jar would keep a copy of the sign-in on disk.
        credentials: 'omit'
      })
    } catch (err) {
      clearTimeout(timer)
      if ((err as { name?: string })?.name === 'AbortError') {
        throw new GatewayError('timeout', 'The gateway did not answer in time.', { cause: err })
      }
      throw new GatewayError('network', 'No connection to the gateway.', { cause: err })
    }
    clearTimeout(timer)

    const setCookie = splitSetCookie(response.headers.get('set-cookie'))
    if (setCookie.length && this.onSetCookie) {
      // Merge into the cookie as it is now, not as it was when this request
      // left: a request that answered in between may have refreshed it, and
      // with the platform jar off nothing else would keep the newer value.
      this.onSetCookie(mergeCookieHeader(this.getAuth().cookie, setCookie))
    }

    const text = await response.text()
    let parsed: unknown = undefined
    if (text) {
      try {
        parsed = JSON.parse(text)
      } catch {
        parsed = text
      }
    }
    return { status: response.status, body: parsed }
  }
}
