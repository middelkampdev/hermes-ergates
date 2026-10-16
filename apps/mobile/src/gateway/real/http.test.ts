import { describe, expect, it, vi } from 'vitest'

import { PUBLIC_HTTP_REFUSAL } from '../address'
import { InsecureTransportError, isGatewayError } from '../errors'
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

  it('merges a late answer into the cookie as it is when that answer arrives, so it cannot undo a newer refresh', async () => {
    const answer = new Map<string, (response: Response) => void>()
    const impl = vi.fn(
      (url: string | URL | Request) =>
        new Promise<Response>(resolve => {
          answer.set(new URL(String(url)).pathname, resolve)
        })
    ) as unknown as typeof fetch
    let auth: HttpAuthState = { mode: 'password', cookie: 'hermes_session_at=old' }
    const http = new HttpClient({
      baseUrl: 'http://gw.local',
      getAuth: () => auth,
      onSetCookie: cookie => {
        auth = { ...auth, cookie }
      },
      fetchImpl: impl
    })

    const startedFirst = http.get('/api/first')
    const startedSecond = http.get('/api/second')
    answer.get('/api/second')?.(new Response('{}', { status: 200, headers: { 'set-cookie': 'hermes_session_at=new; Path=/' } }))
    await startedSecond
    answer.get('/api/first')?.(new Response('{}', { status: 200, headers: { 'set-cookie': 'hermes_session_provider=basic; Path=/' } }))
    await startedFirst

    expect(auth.cookie).toBe('hermes_session_at=new; hermes_session_provider=basic')
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

describe('HttpClient transport guard', () => {
  const client = (baseUrl: string, impl: typeof fetch) => new HttpClient({ baseUrl, getAuth: () => ({ mode: 'token', token: 'tok-1' }), fetchImpl: impl })

  it.each(['http://8.8.8.8:9119', 'http://hermes.example.com', 'hermes.example.com:9119', 'http://hermes.tail1234.ts.net', 'http://HERMES.TAIL1234.TS.NET:9119'])(
    'refuses %s over plain http before fetch is called',
    async baseUrl => {
      const { impl, calls } = fetchStub(200, { ok: true })
      const http = client(baseUrl, impl)

      await expect(http.get('/api/status')).rejects.toBeInstanceOf(InsecureTransportError)
      await expect(http.post('/auth/password-login', { password: 'p' })).rejects.toThrow(PUBLIC_HTTP_REFUSAL)
      await expect(http.exchange('GET', '/api/status')).rejects.toBeInstanceOf(InsecureTransportError)
      await expect(http.get('/api/profiles')).rejects.toSatisfy((e: unknown) => isGatewayError(e) && e.kind === 'insecure_transport')

      expect(impl).not.toHaveBeenCalled()
      expect(calls).toHaveLength(0)
    }
  )

  it.each(['http://192.168.1.10:9119', 'http://100.101.102.103:9119', 'http://127.0.0.1:9119', 'http://hermes.local'])('sends %s over plain http', async baseUrl => {
    const { impl, calls } = fetchStub(200, { ok: true })

    await client(baseUrl, impl).get('/api/status')

    expect(calls[0]?.url).toBe(`${baseUrl}/api/status`)
  })

  it.each(['https://hermes.example.com', 'https://hermes.tail1234.ts.net', 'https://8.8.8.8:9119'])('sends %s over https', async baseUrl => {
    const { impl, calls } = fetchStub(200, { ok: true })

    await client(baseUrl, impl).get('/api/status')

    expect(calls[0]?.url).toBe(`${baseUrl}/api/status`)
  })

  it('builds a client for any address and refuses only when it sends', () => {
    expect(() => client('http://8.8.8.8:9119', vi.fn() as unknown as typeof fetch)).not.toThrow()
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
