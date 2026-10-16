import { afterEach, describe, expect, it, vi } from 'vitest'

import { FakeWebSocket, fakeSocketFactory, flush, installFakeWebSocket } from '@test/fake-gateway/fake-websocket'

import { PUBLIC_HTTP_REFUSAL } from '../address'
import { isGatewayError, userMessage } from '../errors'
import { createAuthSecretStore } from '../secrets'
import { RealGateway } from './real-gateway'
import { MemorySecretStore, type SecretStore } from './secrets'

const originalWebSocket = (globalThis as { WebSocket?: unknown }).WebSocket

afterEach(() => {
  ;(globalThis as { WebSocket?: unknown }).WebSocket = originalWebSocket
})

const KEYS = ['ergates.c1.mode', 'ergates.c1.token', 'ergates.c1.cookie']

/** A fetch double that answers per path. */
function routes(handlers: Record<string, { status: number; body?: unknown; headers?: Record<string, string> }>) {
  const seen: string[] = []
  const urls: string[] = []
  const impl = vi.fn(async (url: string | URL | Request) => {
    const full = String(url)
    urls.push(full)
    const path = new URL(full).pathname
    seen.push(path)
    const route = handlers[path] ?? { status: 404, body: { detail: 'not found' } }
    return new Response(route.body === undefined ? '' : JSON.stringify(route.body), {
      status: route.status,
      headers: { 'content-type': 'application/json', ...(route.headers ?? {}) }
    })
  }) as unknown as typeof fetch
  return { impl, seen, urls }
}

function gatewayWith(handlers: Parameters<typeof routes>[0]) {
  const secrets = new MemorySecretStore()
  const { impl, seen, urls } = routes(handlers)
  const gateway = new RealGateway({ connectionId: 'c1', baseUrl: 'http://gw.local', secrets, fetchImpl: impl })
  return { gateway, secrets, seen, urls }
}

async function storedKeys(secrets: MemorySecretStore): Promise<string[]> {
  const found: string[] = []
  for (const key of KEYS) {
    if ((await secrets.get(key)) !== null) {
      found.push(key)
    }
  }
  return found
}

describe('token login', () => {
  it('persists the token after the probe succeeds', async () => {
    const { gateway, secrets } = gatewayWith({ '/api/profiles': { status: 200, body: { profiles: [] } } })
    await gateway.login({ mode: 'token', token: 'tok-1' })
    expect(gateway.authMode).toBe('token')
    expect(await storedKeys(secrets)).toEqual(['ergates.c1.mode', 'ergates.c1.token'])
  })

  it('rolls back the in-memory auth when the probe fails', async () => {
    const { gateway, secrets } = gatewayWith({ '/api/profiles': { status: 401, body: { detail: 'Unauthorized' } } })
    await expect(gateway.login({ mode: 'token', token: 'bad' })).rejects.toSatisfy((e: unknown) => isGatewayError(e) && e.kind === 'unauthorized')
    // A rejected token must not leave the client half-authenticated.
    expect(gateway.authMode).toBe('none')
    expect(await storedKeys(secrets)).toEqual([])
  })
})

describe('password login', () => {
  it('clears every secret when the login fails after a Set-Cookie', async () => {
    // `onSetCookie` stores any cookie it sees, including one from a login that
    // then fails. The cookie of a login that did not finish must not stay
    // behind, for a new connection or for a saved one signing in again.
    const { gateway, secrets } = gatewayWith({
      '/auth/password-login': { status: 200, body: { ok: false }, headers: { 'set-cookie': 'hermes_session_at=abc; Path=/' } }
    })
    await expect(gateway.login({ mode: 'password', provider: 'basic', username: 'u', password: 'p' })).rejects.toSatisfy(
      (e: unknown) => isGatewayError(e) && e.kind === 'unauthorized'
    )
    expect(await storedKeys(secrets)).toEqual([])
    expect(gateway.authMode).toBe('none')
  })

  it('clears every secret when whoAmI fails after a successful login', async () => {
    const { gateway, secrets } = gatewayWith({
      '/auth/password-login': { status: 200, body: { ok: true }, headers: { 'set-cookie': 'hermes_session_at=abc; Path=/' } },
      '/api/auth/me': { status: 500, body: { detail: 'boom' } }
    })
    await expect(gateway.login({ mode: 'password', provider: 'basic', username: 'u', password: 'p' })).rejects.toThrow()
    expect(await storedKeys(secrets)).toEqual([])
  })

  it('keeps the cookie when the login succeeds', async () => {
    const { gateway, secrets } = gatewayWith({
      '/auth/password-login': { status: 200, body: { ok: true }, headers: { 'set-cookie': 'hermes_session_at=abc; Path=/' } },
      '/api/auth/me': { status: 200, body: { user_id: 'u1' } }
    })
    const me = await gateway.login({ mode: 'password', provider: 'basic', username: 'u', password: 'p' })
    expect(me?.user_id).toBe('u1')
    expect(await storedKeys(secrets)).toEqual(['ergates.c1.mode', 'ergates.c1.cookie'])
  })
})

describe('password sign-in on a rooted or jailbroken phone', () => {
  it('never writes the sign-in or a refreshed cookie to the phone, and a restart finds none', async () => {
    const disk = new MemorySecretStore()
    const recordingPersistent: SecretStore = {
      get: key => disk.get(key),
      set: vi.fn((key: string, value: string) => disk.set(key, value)),
      remove: key => disk.remove(key)
    }
    const secrets = createAuthSecretStore(recordingPersistent)
    secrets.useMemoryOnly()
    const { impl } = routes({
      '/auth/password-login': { status: 200, body: { ok: true }, headers: { 'set-cookie': 'hermes_session_at=first; Path=/' } },
      '/api/auth/me': { status: 200, body: { user_id: 'u1' } },
      // A mid-session refresh: any answer may carry a new session cookie.
      '/api/profiles': { status: 200, body: { profiles: [] }, headers: { 'set-cookie': 'hermes_session_at=refreshed; Path=/' } }
    })
    const gateway = new RealGateway({ connectionId: 'c1', baseUrl: 'http://gw.local', secrets, fetchImpl: impl })

    await gateway.login({ mode: 'password', provider: 'basic', username: 'u', password: 'p' })
    await gateway.http.get('/api/profiles')
    await flush()

    // The refresh reached the in-memory sign-in, so the path through `onSetCookie` ran.
    expect(await secrets.get('ergates.c1.cookie')).toBe('hermes_session_at=refreshed')
    expect(recordingPersistent.set).not.toHaveBeenCalled()

    const afterRestart = new RealGateway({ connectionId: 'c1', baseUrl: 'http://gw.local', secrets: createAuthSecretStore(recordingPersistent), fetchImpl: impl })
    await expect(afterRestart.restore()).resolves.toBe('none')
  })
})

describe('socket cache', () => {
  it('drops a terminally failed socket so a later connect rebuilds it', async () => {
    const secrets = new MemorySecretStore()
    const { impl } = routes({ '/api/profiles': { status: 200, body: { profiles: [] } } })
    installFakeWebSocket({})
    const gateway = new RealGateway({ connectionId: 'c1', baseUrl: 'http://gw.local', secrets, fetchImpl: impl, socketFactory: fakeSocketFactory })
    await gateway.login({ mode: 'token', token: 'tok-1' })

    const first = await gateway.connect('thijs')
    expect(FakeWebSocket.instances).toHaveLength(1)

    // A socket that opened and then failed terminally used to stay cached, so
    // every later connect() handed out the same dead promise for the life of the
    // process - the connection stayed bricked even after a re-login.
    FakeWebSocket.instances[0]?.serverClose(4401, 'auth: ticket expired')
    await flush(20)
    expect(first.lastError).toMatchObject({ kind: 'unauthorized', terminal: true })

    const second = await gateway.connect('thijs')
    expect(second).not.toBe(first)
    expect(FakeWebSocket.instances).toHaveLength(2)
    gateway.disconnectAll()
  })
})

describe('server requests', () => {
  it('answers approval and clarify with response frames on the session socket', async () => {
    const secrets = new MemorySecretStore()
    const { impl } = routes({ '/api/profiles': { status: 200, body: { profiles: [] } } })
    installFakeWebSocket({ onRequest: m => (m === 'session.create' ? { session_id: 's1', stored_session_id: 'st1' } : {}) })
    const gateway = new RealGateway({ connectionId: 'c1', baseUrl: 'http://gw.local', secrets, fetchImpl: impl, socketFactory: fakeSocketFactory })
    await gateway.login({ mode: 'token', token: 'tok-1' })

    await gateway.sessions.create({ title: 'Bot Chat', profile: 'thijs' })
    const ws = FakeWebSocket.instances.at(-1)!
    ws.serverRequest('srq-00000000000c', 'clarify', { session_id: 's1', questions: [{ qid: 'q0', question: 'Tea?' }] })
    await flush()
    await gateway.sessions.respondClarify({ session_id: 's1', request_id: 'srq-00000000000c', answers: { q0: 'A' } })
    expect(ws.sent.filter(f => f.id === 'srq-00000000000c')).toEqual([{ jsonrpc: '2.0', id: 'srq-00000000000c', result: { answers: { q0: 'A' } } }])
    expect(ws.sent.some(f => f.method === 'clarify.respond' || f.method === 'approval.respond')).toBe(false)
    await expect(gateway.sessions.respondApproval({ session_id: 's1', request_id: 'srq-00000000000d', choice: 'once' })).rejects.toMatchObject({ kind: 'not_found' })
    gateway.disconnectAll()
  })
})

describe('sessions.transcript', () => {
  it('sends profile, limit, offset and order explicitly and returns the normalized rows', async () => {
    const { gateway, urls } = gatewayWith({
      '/api/sessions/20260914_1/messages': {
        status: 200,
        body: {
          session_id: '20260914_1',
          profile: 'default',
          messages: [
            { id: 1, role: 'user', content: 'hi', timestamp: 1 },
            { id: 2, role: 'assistant', content: 'hello', timestamp: 2 }
          ],
          pagination: { limit: 50, offset: 0, order: 'latest', returned: 2 }
        }
      }
    })
    const page = await gateway.sessions.transcript('20260914_1', { profile: 'default', limit: 50, order: 'latest' })

    expect(urls).toHaveLength(1)
    const requested = new URL(urls[0]!)
    expect(requested.pathname).toBe('/api/sessions/20260914_1/messages')
    expect(requested.searchParams.get('profile')).toBe('default')
    expect(requested.searchParams.get('limit')).toBe('50')
    expect(requested.searchParams.get('offset')).toBe('0')
    expect(requested.searchParams.get('order')).toBe('latest')

    expect(page.sessionId).toBe('20260914_1')
    expect(page.rows).toEqual([
      { id: 1, role: 'user', text: 'hi', content: 'hi', at: 1 },
      { id: 2, role: 'assistant', text: 'hello', content: 'hello', at: 2 }
    ])
    expect(page.page).toEqual({ limit: 50, offset: 0, returned: 2 })
  })
})

describe('a connection saved before the app graded addresses', () => {
  it('fails the roster, the status and an Ergates read of a public address over plain http with the refusal, and sends nothing', async () => {
    const secrets = new MemorySecretStore()
    await secrets.set('ergates.c1.mode', 'token')
    await secrets.set('ergates.c1.token', 'tok-1')
    const { impl } = routes({})
    installFakeWebSocket({})
    const socketFactory = vi.fn(fakeSocketFactory)
    const gateway = new RealGateway({ connectionId: 'c1', baseUrl: 'http://203.0.113.10:9119', secrets, fetchImpl: impl, socketFactory })

    const failures = await Promise.all([gateway.profiles.list(), gateway.status(), gateway.ergates.health()].map(read => read.then(() => null, (err: unknown) => err)))

    for (const failure of failures) {
      expect(isGatewayError(failure) && failure.kind).toBe('insecure_transport')
      expect(userMessage(failure)).toBe(PUBLIC_HTTP_REFUSAL)
    }
    expect(impl).not.toHaveBeenCalled()
    expect(socketFactory).not.toHaveBeenCalled()
  })
})

describe('discardStoredSecrets', () => {
  it('removes what this phone stores for the id, without a request', async () => {
    const { gateway, secrets, seen } = gatewayWith({
      '/auth/password-login': { status: 200, body: { ok: true }, headers: { 'set-cookie': 'hermes_session_at=abc; Path=/' } },
      '/api/auth/me': { status: 200, body: { user_id: 'u1' } }
    })
    await gateway.login({ mode: 'password', provider: 'basic', username: 'u', password: 'p' })
    await secrets.set('ergates.c1.token', 'tok-old')
    const requests = seen.length

    await gateway.discardStoredSecrets()

    expect(await storedKeys(secrets)).toEqual([])
    expect(seen).toHaveLength(requests)
    expect(gateway.authMode).toBe('none')
  })
})

describe('logout', () => {
  it('revokes, then clears the cookie and all three secrets even when the revoke fails', async () => {
    const { gateway, secrets, seen } = gatewayWith({
      '/auth/password-login': { status: 200, body: { ok: true }, headers: { 'set-cookie': 'hermes_session_at=abc; Path=/' } },
      '/api/auth/me': { status: 200, body: { user_id: 'u1' } },
      '/auth/logout': { status: 500, body: { detail: 'offline' } }
    })
    await gateway.login({ mode: 'password', provider: 'basic', username: 'u', password: 'p' })
    await gateway.logout()
    expect(seen).toContain('/auth/logout')
    expect(await storedKeys(secrets)).toEqual([])
    expect(gateway.authMode).toBe('none')
  })
})

describe('ergates routes after a cold start', () => {
  /** A gateway on stored credentials, never restored by a screen, and a fetch double that answers 401 without them. */
  async function coldGateway(stored: Record<string, string>, expected: { header: string; value: string }) {
    const secrets = new MemorySecretStore()
    for (const [key, value] of Object.entries(stored)) {
      await secrets.set(key, value)
    }
    const sent: Record<string, string>[] = []
    const receipt = { proposal_id: 'p-1', state: 'proposed', reserved_profile_name: 'pim', expires_at: '2999-01-01T00:00:00Z', completed_steps: [], step_status: {}, next_step: 'profile_created', template: null }
    const reminder = { request_id: 'r-1', profile: 'pim', job_id: 'j-1', state: 'created' }
    const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>
      sent.push(headers)
      if (headers[expected.header] !== expected.value) {
        return new Response(JSON.stringify({ detail: 'Unauthorized' }), { status: 401, headers: { 'content-type': 'application/json' } })
      }
      const path = new URL(String(url)).pathname
      const body = path.endsWith('/reminders') ? { receipt: reminder } : { proposal: receipt }
      return new Response(JSON.stringify(body), { status: path.endsWith('/reminders') ? 201 : 200, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch
    const gateway = new RealGateway({ connectionId: 'c1', baseUrl: 'http://gw.local', secrets, fetchImpl: impl })
    return { gateway, sent }
  }

  it('loads the stored token before the first Ergates call (a push link opens a chat without Home)', async () => {
    const { gateway, sent } = await coldGateway({ 'ergates.c1.mode': 'token', 'ergates.c1.token': 'tok-1' }, { header: 'X-Hermes-Session-Token', value: 'tok-1' })

    await expect(gateway.ergates.getProposal('p-1')).resolves.toMatchObject({ proposal_id: 'p-1', state: 'proposed' })
    expect(sent).toHaveLength(1)
    expect(gateway.authMode).toBe('token')
  })

  it('loads the stored cookie before a reminder create too', async () => {
    const { gateway, sent } = await coldGateway({ 'ergates.c1.mode': 'password', 'ergates.c1.cookie': 'hermes_session_at=abc' }, { header: 'Cookie', value: 'hermes_session_at=abc' })

    const outcome = await gateway.ergates.createReminder({ request_id: 'r-1', profile: 'pim', schedule: '0 9 * * *', timezone: 'Europe/Amsterdam', prompt: 'Check the invoices.' })

    expect(outcome.status).toBe('created')
    expect(sent).toHaveLength(1)
  })
})
