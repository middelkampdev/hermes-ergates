import { describe, expect, it, vi } from 'vitest'

import { isGatewayError } from '../errors'
import { HttpClient, mergeCookieHeader, normalizeBaseUrl, splitSetCookie, type HttpAuthState } from './http'

function fetchStub(status: number, body: unknown, headers: Record<string, string> = {}) {
  const calls: { url: string; init: RequestInit }[] = []
  const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
  }) as unknown as typeof fetch
  return { impl, calls }
}

describe('HttpClient', () => {
  it('sends the session token header in token mode', async () => {
    const { impl, calls } = fetchStub(200, { ok: true })
    const auth: HttpAuthState = { mode: 'token', token: 'tok-1' }
    const http = new HttpClient({ baseUrl: 'http://127.0.0.1:9119/', getAuth: () => auth, fetchImpl: impl })
    await http.get('/api/health')
    expect(calls[0]?.url).toBe('http://127.0.0.1:9119/api/health')
    expect((calls[0]?.init.headers as Record<string, string>)['X-Hermes-Session-Token']).toBe('tok-1')
    expect((calls[0]?.init.headers as Record<string, string>).Cookie).toBeUndefined()
  })

  it('replays the cookie in password mode and captures set-cookie', async () => {
    const { impl, calls } = fetchStub(200, { ok: true, next: '/' }, { 'set-cookie': 'hermes_session_at=abc; Path=/; HttpOnly, hermes_session_provider=basic; Path=/' })
    let auth: HttpAuthState = { mode: 'password', cookie: 'old=1' }
    const setCookie = vi.fn((c: string) => {
      auth = { ...auth, cookie: c }
    })
    const http = new HttpClient({ baseUrl: 'http://gw.local', getAuth: () => auth, onSetCookie: setCookie, fetchImpl: impl })
    await http.post('/auth/password-login', { provider: 'basic', username: 'u', password: 'p' })
    expect((calls[0]?.init.headers as Record<string, string>).Cookie).toBe('old=1')
    expect(setCookie).toHaveBeenCalledWith('old=1; hermes_session_at=abc; hermes_session_provider=basic')
    expect(calls[0]?.init.body).toBe(JSON.stringify({ provider: 'basic', username: 'u', password: 'p' }))
  })

  it('keeps the platform cookie jar out of requests', async () => {
    const { impl, calls } = fetchStub(200, { ok: true })
    const http = new HttpClient({ baseUrl: 'http://x', getAuth: () => ({ mode: 'password', cookie: 'hermes_session_at=abc' }), fetchImpl: impl })
    await http.get('/api/profiles')
    expect(calls[0]?.init.credentials).toBe('omit')
  })

  it('maps 401 to unauthorized', async () => {
    const { impl } = fetchStub(401, { detail: 'Unauthorized' })
    const http = new HttpClient({ baseUrl: 'http://x', getAuth: () => ({ mode: 'none' }), fetchImpl: impl })
    await expect(http.get('/api/profiles')).rejects.toSatisfy((e: unknown) => isGatewayError(e) && e.kind === 'unauthorized')
  })

  it('treats a manual redirect as success', async () => {
    const { impl } = fetchStub(302, '', { location: '/login' })
    const http = new HttpClient({ baseUrl: 'http://x', getAuth: () => ({ mode: 'password', cookie: 'a=b' }), fetchImpl: impl })
    await expect(http.post('/auth/logout')).resolves.toBeUndefined()
  })

  it('answers the status and the body of any exchange without mapping it', async () => {
    const { impl } = fetchStub(409, { error: { code: 'conflict', message: 'used' }, receipt: { id: 'r1' } })
    const http = new HttpClient({ baseUrl: 'http://x', getAuth: () => ({ mode: 'none' }), fetchImpl: impl })
    await expect(http.exchange('POST', '/api/plugins/ergates/reminders', { a: 1 })).resolves.toEqual({
      status: 409,
      body: { error: { code: 'conflict', message: 'used' }, receipt: { id: 'r1' } }
    })
  })

  it('lets one request wait longer than the client default', async () => {
    vi.useFakeTimers()
    const impl = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
        })
    ) as unknown as typeof fetch
    const http = new HttpClient({ baseUrl: 'http://x', getAuth: () => ({ mode: 'none' }), fetchImpl: impl, timeoutMs: 1_000 })
    let outcome: unknown = 'pending'
    void http.request('GET', '/slow', undefined, { timeoutMs: 5_000 }).catch((err: unknown) => {
      outcome = err
    })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(outcome).toBe('pending')
    await vi.advanceTimersByTimeAsync(4_000)
    expect(outcome).toMatchObject({ kind: 'timeout' })
    vi.useRealTimers()
  })

  it('sends Content-Type: application/json for every body an exchange carries (the server refuses anything else)', async () => {
    const { impl, calls } = fetchStub(200, { ok: true })
    const http = new HttpClient({ baseUrl: 'http://x', getAuth: () => ({ mode: 'none' }), fetchImpl: impl })
    await http.exchange('PUT', '/api/plugins/ergates/attention/prefs', { profile: '*', muted: false, quiet_start: null, quiet_end: null })
    expect((calls[0]?.init.headers as Record<string, string>)['Content-Type']).toBe('application/json')
  })

  it('maps a thrown fetch to network', async () => {
    const impl = vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    }) as unknown as typeof fetch
    const http = new HttpClient({ baseUrl: 'http://x', getAuth: () => ({ mode: 'none' }), fetchImpl: impl })
    await expect(http.get('/api/status')).rejects.toSatisfy((e: unknown) => isGatewayError(e) && e.kind === 'network')
  })
})

describe('cookie helpers', () => {
  it('splits combined set-cookie headers without breaking on expiry dates', () => {
    const parts = splitSetCookie('a=1; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Path=/, b=2; Path=/')
    expect(parts).toEqual(['a=1; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Path=/', 'b=2; Path=/'])
  })
  it('merges and deletes cookies', () => {
    expect(mergeCookieHeader('a=1; b=2', ['b=; Max-Age=0', 'c=3; Path=/'])).toBe('a=1; c=3')
  })
  it('normalizes base urls', () => {
    expect(normalizeBaseUrl(' 127.0.0.1:9119/ ')).toBe('http://127.0.0.1:9119')
    expect(normalizeBaseUrl('https://gw.tail.net')).toBe('https://gw.tail.net')
  })
})
