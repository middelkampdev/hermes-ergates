/**
 * The Ergates routes over the connection's own HTTP client: paths, bodies,
 * auth, the status of each answer and the error codes. The server behavior
 * behind the routes is the integration's own suite; the fake in
 * test/fake-gateway/fake-ergates.ts mirrors it for the app tests.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AgentProposal, ErgatesHealth, ReminderReceipt, SetupState } from '../types'
import { isGatewayError, type GatewayError } from '../errors'
import { REMINDER_TIMEOUT_MS } from './ergates-api'
import { RealGateway } from './real-gateway'
import { MemorySecretStore } from './secrets'

interface Seen {
  method: string
  path: string
  headers: Record<string, string>
  body: unknown
}

/** A fetch double: `answer` gets each request and returns [status, body]. */
function server(answer: (req: Seen) => [number, unknown]) {
  const seen: Seen[] = []
  const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const parsed = new URL(String(url))
    const req: Seen = {
      method: init?.method ?? 'GET',
      path: `${parsed.pathname}${parsed.search}`,
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
    }
    seen.push(req)
    const [status, body] = answer(req)
    return new Response(body === undefined ? '' : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
  return { impl, seen }
}

async function connected(answer: (req: Seen) => [number, unknown], mode: 'token' | 'password' = 'token') {
  const secrets = new MemorySecretStore()
  await secrets.set('ergates.c1.mode', mode)
  await secrets.set(mode === 'token' ? 'ergates.c1.token' : 'ergates.c1.cookie', mode === 'token' ? 'tok-1' : 'hermes_session_at=abc')
  const { impl, seen } = server(answer)
  const gateway = new RealGateway({ connectionId: 'c1', baseUrl: 'http://gw.local', secrets, fetchImpl: impl })
  await gateway.restore()
  return { api: gateway.ergates, seen }
}

const receipt: ReminderReceipt = {
  id: 'rem-1',
  request_id: 'rem-1',
  profile: 'thijs',
  state: 'created',
  job_id: 'job-1',
  timezone_advisory: 'Europe/Amsterdam',
  payload_hash: 'abc'
}

const request = { profile: 'thijs', schedule: '0 9 * * *', timezone: 'Europe/Amsterdam', prompt: 'Check the invoices.', request_id: 'rem-1', label: 'Invoices' }

const proposal: AgentProposal = {
  kind: 'ergates.agent-proposal.v1',
  proposal_id: 'p-1',
  expires_at: '2026-09-26T10:00:00Z',
  source_session_id: 'concierge-1',
  agent: { name: 'pim', title: 'Pim', role: 'Bookkeeper', description: 'Keeps the books.', template_id: 'bookkeeper', provider: 'p', model: 'm' },
  briefing: 'Seed facts.'
}

const receiptOf = (state: string) => ({
  proposal_id: 'p-1',
  state,
  reserved_profile_name: 'pim',
  expires_at: proposal.expires_at,
  completed_steps: [],
  step_status: {},
  next_step: 'profile_created',
  template: null
})

async function rejection(promise: Promise<unknown>): Promise<GatewayError> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e
  )
  if (!isGatewayError(err)) {
    throw new Error(`expected a GatewayError, got ${String(err)}`)
  }
  return err
}

afterEach(() => {
  vi.useRealTimers()
})

/** What the plugin answers on `GET /health` (`operations.py`, `Operations.health`). */
const health: ErgatesHealth = {
  ok: true,
  plugin_version: '0.2.0',
  api_level: 1,
  min_api_level: 1,
  schema_version: 1,
  store: { plugin_schema_version: 1, min_schema_version: 1, writable: true },
  install: { kind: 'git install', commit: 'a'.repeat(40), catalog_name: null },
  setup: { finished: true, templates: 'installed', profiles: [{ name: 'default', enabled: true }] },
  push: { configured: false, token_set: false, legacy_config_token: false },
  sweep: { interval_seconds: 120, last_run_at: 1790000000.5, last_error: null }
}

/** What an older plugin answers: only the first three fields. */
const olderHealth: ErgatesHealth = { ok: true, schema_version: 1, plugin_version: '0.2.0' }

describe('ErgatesApi over the real gateway', () => {
  it('calls the plugin routes with the connection token', async () => {
    const { api, seen } = await connected(() => [200, health])

    await expect(api.health()).resolves.toEqual({ state: 'answered', health })
    expect(seen[0]).toMatchObject({ method: 'GET', path: '/api/plugins/ergates/health' })
    expect(seen[0]!.headers['X-Hermes-Session-Token']).toBe('tok-1')
  })

  it('sends the cookie in gated mode', async () => {
    const { api, seen } = await connected(() => [200, health], 'password')

    await api.health()
    expect(seen[0]!.headers.Cookie).toBe('hermes_session_at=abc')
    expect(seen[0]!.headers['X-Hermes-Session-Token']).toBeUndefined()
  })

  it('loads the stored sign-in before the first health read of a cold start', async () => {
    const secrets = new MemorySecretStore()
    await secrets.set('ergates.c1.mode', 'token')
    await secrets.set('ergates.c1.token', 'tok-1')
    const { impl, seen } = server(() => [200, health])
    const gateway = new RealGateway({ connectionId: 'c1', baseUrl: 'http://gw.local', secrets, fetchImpl: impl })

    await gateway.ergates.health()
    expect(seen[0]!.headers['X-Hermes-Session-Token']).toBe('tok-1')
  })

  it('answers with exactly the fields an older plugin sends, and invents none', async () => {
    const { api } = await connected(() => [200, olderHealth])

    await expect(api.health()).resolves.toEqual({ state: 'answered', health: olderHealth })
  })

  it.each([
    ['a kind this app does not know', { kind: 'container image', commit: null, catalog_name: null }],
    ['no kind', { commit: null, catalog_name: null }]
  ] as const)('reads an install with %s as a manual copy', async (_name, install) => {
    const { api } = await connected(() => [200, { ...health, install }])

    await expect(api.health()).resolves.toEqual({ state: 'answered', health: { ...health, install: { ...install, kind: 'manual copy' } } })
  })

  it('keeps each install kind it knows', async () => {
    for (const kind of ['git install', 'manual copy'] as const) {
      const { api } = await connected(() => [200, { ...health, install: { ...health.install, kind } }])

      await expect(api.health()).resolves.toMatchObject({ health: { install: { kind } } })
    }
  })

  it('passes the commit the plugin was loaded from through', async () => {
    const { api } = await connected(() => [200, { ...health, install: { ...health.install, loaded_commit: 'b'.repeat(40) } }])

    await expect(api.health()).resolves.toMatchObject({ health: { install: { commit: 'a'.repeat(40), loaded_commit: 'b'.repeat(40) } } })
  })

  it('keeps a loaded commit of null: a manual copy has none', async () => {
    const { api } = await connected(() => [200, { ...health, install: { kind: 'manual copy', commit: null, loaded_commit: null, catalog_name: null } }])

    const answer = await api.health()
    expect(answer).toMatchObject({ health: { install: { loaded_commit: null } } })
  })

  it.each([
    ['a number', 5],
    ['an object', {}],
    ['a list', ['b'.repeat(40)]],
    ['a boolean', true]
  ] as const)('reads a loaded commit that is %s as null', async (_name, loaded) => {
    const { api } = await connected(() => [200, { ...health, install: { ...health.install, loaded_commit: loaded } }])

    const answer = await api.health()
    expect(answer).toMatchObject({ health: { install: { kind: 'git install', commit: 'a'.repeat(40), loaded_commit: null } } })
  })

  it('leaves the loaded commit out when an older plugin sends none', async () => {
    const { api } = await connected(() => [200, health])

    const answer = await api.health()
    if (answer.state !== 'answered') {
      throw new Error('expected an answer')
    }
    expect(answer.health.install).not.toHaveProperty('loaded_commit')
  })

  it('drops an install field that is not an object, as an older plugin sends none', async () => {
    const { api } = await connected(() => [200, { ...health, install: 'git install' }])

    const withoutInstall: ErgatesHealth = { ...health }
    delete withoutInstall.install
    await expect(api.health()).resolves.toEqual({ state: 'answered', health: withoutInstall })
  })

  it('reads the 404 of a plugin Hermes does not serve as absent', async () => {
    const { api } = await connected(() => [404, { detail: 'Plugin not found' }])

    await expect(api.health()).resolves.toEqual({ state: 'absent' })
  })

  it.each([
    ['an enabled plugin whose routes are not mounted', { detail: 'Not Found' }],
    ['a detail that only resembles the not-installed one', { detail: 'Plugin not found.' }],
    ['a body without a detail', { message: 'Plugin not found' }],
    ['no body', undefined],
    ['a body that is not JSON', '<html>Not Found</html>']
  ] as const)('reads a 404 with %s as not loaded', async (_name, body) => {
    const { api } = await connected(() => [404, body])

    await expect(api.health()).resolves.toEqual({ state: 'not_loaded' })
  })

  it('rejects a health read the gateway refuses to authenticate', async () => {
    const { api } = await connected(() => [401, { detail: 'Unauthorized' }])

    const err = await rejection(api.health())
    expect(err).toMatchObject({ kind: 'unauthorized', status: 401 })
    expect(err.code).toBeUndefined()
  })

  it('rejects a health read the plugin cannot answer with its error code', async () => {
    const { api } = await connected(() => [503, { error: { code: 'store_unavailable', message: 'the Ergates control store is unavailable' } }])

    const err = await rejection(api.health())
    expect(err).toMatchObject({ kind: 'unknown', status: 503, code: 'store_unavailable', message: 'the Ergates control store is unavailable' })
  })

  it('rejects a 200 health answer that is not a JSON object', async () => {
    const { api } = await connected(() => [200, '<html>Ergates</html>'])

    await expect(rejection(api.health())).resolves.toMatchObject({ status: 200 })
  })

  it('runs the plugin setup with an empty JSON object and resolves its report', async () => {
    const setup: SetupState = { finished: false, templates: 'installed', profiles: [{ name: 'default', enabled: true }, { name: 'pim', enabled: false, error: 'PermissionError' }] }
    const { api, seen } = await connected(() => [200, { setup }])

    await expect(api.setup()).resolves.toEqual(setup)
    expect(seen[0]).toMatchObject({ method: 'POST', path: '/api/plugins/ergates/setup', body: {} })
    expect(seen[0]!.headers['X-Hermes-Session-Token']).toBe('tok-1')
  })

  it.each([
    ['no setup report', {}],
    ['a setup report that is not an object', { setup: 'done' }],
    ['a setup report without a list of profiles', { setup: { finished: true, templates: 'installed' } }],
    ['a setup report whose profiles are not a list', { setup: { finished: true, templates: 'installed', profiles: { default: true } } }]
  ] as const)('rejects a setup answer with %s as unknown, so no screen reads a report that is not there', async (_name, body) => {
    const { api } = await connected(() => [200, body])

    const err = await rejection(api.setup())
    expect(err).toMatchObject({ kind: 'unknown', message: 'The plugin did not answer with a setup report.' })
  })

  it('rejects a setup the gateway cannot route as not found', async () => {
    const { api } = await connected(() => [404, { detail: 'Plugin not found' }])

    const err = await rejection(api.setup())
    expect(err).toMatchObject({ kind: 'not_found', status: 404 })
    expect(err.code).toBeUndefined()
  })

  it.each([
    [201, 'created'],
    [200, 'existing'],
    [202, 'uncertain']
  ] as const)('resolves a %i reminder answer as %s', async (status, outcome) => {
    const { api, seen } = await connected(() => [status, { receipt }])

    await expect(api.createReminder(request)).resolves.toEqual({ status: outcome, receipt })
    expect(seen[0]).toMatchObject({ method: 'POST', path: '/api/plugins/ergates/reminders', body: request })
  })

  it('resolves a 409 conflict with the receipt it carries', async () => {
    const { api } = await connected(() => [409, { error: { code: 'conflict', message: 'this request_id was already used for a different reminder' }, receipt }])

    await expect(api.createReminder(request)).resolves.toEqual({ status: 'conflict', receipt })
  })

  it.each([
    [400, 'invalid', 'unknown'],
    [404, 'unknown_profile', 'not_found'],
    [503, 'store_unavailable', 'unknown']
  ] as const)('rejects a %i reminder answer with the error code %s', async (status, code, kind) => {
    const { api } = await connected(() => [status, { error: { code, message: 'label must be 1 to 64 printable characters' } }])

    const err = await rejection(api.createReminder(request))
    expect(err).toMatchObject({ code, kind, status })
  })

  it('rejects a 400 invalid reminder answer with a promise, never a ReminderOutcome', async () => {
    const { api } = await connected(() => [400, { error: { code: 'invalid', message: 'schedule is not one Hermes cron accepts' } }])

    const err = await rejection(api.createReminder(request))
    expect(err).toMatchObject({ code: 'invalid', status: 400 })
  })

  it('maps a 401 from Hermes auth, which has no Ergates error body, like any other route', async () => {
    const { api } = await connected(() => [401, { detail: 'Unauthorized' }])

    const err = await rejection(api.getProposal('p-1'))
    expect(err).toMatchObject({ kind: 'unauthorized', status: 401 })
    expect(err.code).toBeUndefined()
  })

  it('maps an internal 500 like the server sends on an unexpected failure', async () => {
    const { api } = await connected(() => [500, { error: { code: 'internal', message: 'The request could not be completed.' } }])

    const err = await rejection(api.getProposal('p-1'))
    expect(err).toMatchObject({ status: 500, code: 'internal', message: 'The request could not be completed.' })
  })

  it('gives a reminder create 60 seconds, twice the default', async () => {
    vi.useFakeTimers()
    const secrets = new MemorySecretStore()
    await secrets.set('ergates.c1.mode', 'token')
    await secrets.set('ergates.c1.token', 'tok-1')
    // Never answers; rejects only when its signal aborts.
    const impl = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
        })
    ) as unknown as typeof fetch
    const gateway = new RealGateway({ connectionId: 'c1', baseUrl: 'http://gw.local', secrets, fetchImpl: impl })
    await gateway.restore()

    let settled: unknown = 'pending'
    const creating = gateway.ergates.createReminder(request).then(
      () => 'resolved',
      (err: unknown) => err
    )
    void creating.then(value => {
      settled = value
    })
    await vi.advanceTimersByTimeAsync(30_000)
    expect(settled).toBe('pending')
    await vi.advanceTimersByTimeAsync(REMINDER_TIMEOUT_MS - 30_000)
    expect(settled).toMatchObject({ kind: 'timeout' })
    expect(REMINDER_TIMEOUT_MS).toBeGreaterThanOrEqual(30_000)
  })

  it('reads, accepts, rejects and reports proposal steps', async () => {
    const answers: Record<string, [number, unknown]> = {
      'GET /api/plugins/ergates/proposals/p-1': [200, { proposal: receiptOf('proposed') }],
      'POST /api/plugins/ergates/proposals/p-1/accept': [200, { proposal: { ...receiptOf('accepted'), template: { template_id: 'bookkeeper', soul: 'S', enabled_toolsets: ['file'], enabled_mcp_servers: [] } } }],
      'POST /api/plugins/ergates/proposals/p-1/reject': [200, { proposal: receiptOf('rejected') }],
      'POST /api/plugins/ergates/proposals/p-1/steps': [200, { proposal: { ...receiptOf('accepted'), completed_steps: ['profile_created'], next_step: 'plugin_enabled' } }]
    }
    const { api, seen } = await connected(req => answers[`${req.method} ${req.path}`] ?? [404, { detail: 'Not Found' }])

    expect((await api.getProposal('p-1')).state).toBe('proposed')
    expect((await api.acceptProposal('p-1', proposal)).template?.enabled_toolsets).toEqual(['file'])
    expect((await api.rejectProposal('p-1')).state).toBe('rejected')
    expect((await api.recordProposalStep('p-1', 'profile_created', 'done')).next_step).toBe('plugin_enabled')
    expect(seen.map(s => s.body)).toEqual([undefined, { proposal }, undefined, { step: 'profile_created', status: 'done' }])
  })

  it('rejects a proposal error with its error code', async () => {
    const { api } = await connected(() => [409, { error: { code: 'name_taken', message: "a profile named 'pim' already exists" } }])

    const err = await rejection(api.acceptProposal('p-1', proposal))
    expect(err).toMatchObject({ code: 'name_taken', status: 409, message: "a profile named 'pim' already exists" })
  })

  it('encodes path values', async () => {
    const { api, seen } = await connected(() => [404, { error: { code: 'not_found', message: 'no proposal' } }])

    await rejection(api.getProposal('a/b c'))
    expect(seen[0]!.path).toBe('/api/plugins/ergates/proposals/a%2Fb%20c')
  })

  it('enables the plugin in a profile and reads and writes attention prefs', async () => {
    const prefs = { profile: '*', muted: false, quiet_start: '22:00', quiet_end: '07:00' }
    const answers: Record<string, [number, unknown]> = {
      'POST /api/plugins/ergates/profiles/pim/plugin': [200, { profile: 'pim', enabled: true }],
      'GET /api/plugins/ergates/attention/prefs?scope=*': [200, { prefs }],
      'GET /api/plugins/ergates/attention/prefs?scope=pim': [200, { prefs: { ...prefs, profile: 'pim' } }],
      'PUT /api/plugins/ergates/attention/prefs': [200, { prefs }]
    }
    const { api, seen } = await connected(req => answers[`${req.method} ${req.path}`] ?? [404, { detail: 'Not Found' }])

    await expect(api.enablePlugin('pim')).resolves.toEqual({ profile: 'pim', enabled: true })
    await expect(api.attentionPrefs('*')).resolves.toEqual(prefs)
    await expect(api.attentionPrefs('pim')).resolves.toEqual({ ...prefs, profile: 'pim' })
    await expect(api.setAttentionPrefs(prefs)).resolves.toEqual(prefs)
    expect(seen.at(-1)!.body).toEqual(prefs)
  })

  it('reports a gateway without the plugin as not found, with no error code', async () => {
    const { api } = await connected(() => [404, { detail: 'Not Found' }])

    const err = await rejection(api.attentionPrefs('thijs'))
    expect(err).toMatchObject({ kind: 'not_found', status: 404 })
    expect(err.code).toBeUndefined()
  })
})
