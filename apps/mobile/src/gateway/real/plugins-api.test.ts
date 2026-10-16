/**
 * Hermes's own plugin routes over the connection's HTTP client: paths, bodies,
 * auth, and how the install failures Hermes words in plain text map to codes.
 * The texts are matched by the prefixes in hermes-plugin-messages.json, which
 * the contract suite checks against the pinned Hermes source.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import { isGatewayError, type GatewayError } from '../errors'
import { PLUGIN_INSTALL_TIMEOUT_MS } from '../port'
import type { PluginInstallRequest } from '../types'
import messages from './hermes-plugin-messages.json'
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

async function gatewayWith(impl: typeof fetch, mode: 'token' | 'password' = 'token') {
  const secrets = new MemorySecretStore()
  await secrets.set('ergates.c1.mode', mode)
  await secrets.set(mode === 'token' ? 'ergates.c1.token' : 'ergates.c1.cookie', mode === 'token' ? 'tok-1' : 'hermes_session_at=abc')
  return new RealGateway({ connectionId: 'c1', baseUrl: 'http://gw.local', secrets, fetchImpl: impl })
}

async function connected(answer: (req: Seen) => [number, unknown], mode: 'token' | 'password' = 'token') {
  const { impl, seen } = server(answer)
  const gateway = await gatewayWith(impl, mode)
  await gateway.restore()
  return { api: gateway.plugins, seen }
}

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

const SHA = 'a'.repeat(40)
const request: PluginInstallRequest = { identifier: 'middelkampdev/hermes-ergates/integrations/ergates', ref: SHA, enable: true, force: false }
const INSTALL_PATH = '/api/dashboard/agent-plugins/install'

/** The install failure texts as Hermes 0.21.6 words them for the Ergates install. */
const FAILURES = {
  scan_blocked: [
    'Security scan blocked plugin install: dangerous verdict (1 critical)\n\nVerdict: DANGEROUS\nReview the findings above. Install only plugins from sources you trust. (Scanning can be configured via plugins.scan_on_install in config.yaml.)'
  ],
  no_git: ['git is not installed or not in PATH.'],
  download_failed: [
    'Could not download the plugin from https://github.com/middelkampdev/hermes-ergates. Check the address (browse the catalog with `hermes plugins search`), check your internet connection, or, if the repository is private, sign in first with `gh auth login` (or set GITHUB_TOKEN in your .env).\nDetails: fatal: unable to access',
    'Git clone timed out after 300 seconds. Raise plugins.clone_timeout_seconds in config.yaml for a slow connection.',
    `Git commit '${SHA}' could not be fetched:\nfatal: couldn't find remote ref`,
    `Git checkout of commit '${SHA}' failed:\nfatal: reference is not a tree`,
    `Git fetch of commit '${SHA}' timed out after 300 seconds. Raise plugins.clone_timeout_seconds in config.yaml for a slow connection.`
  ],
  already_installed: ["Plugin 'ergates' already exists. Use force reinstall or run `hermes plugins update ergates`."],
  enable_refused: ['enable refused: the plugin asks for a capability that is not allowed']
} as const

afterEach(() => {
  vi.useRealTimers()
})

describe('PluginsApi over the real gateway: the plugin list', () => {
  it('reads the hub rows Ergates needs and drops the rest', async () => {
    const { api, seen } = await connected(() => [
      200,
      {
        plugins: [
          { name: 'ergates', version: '0.2.0', source: 'user', runtime_status: 'enabled', description: 'The Ergates app server', path: '/home/hermes/plugins/ergates' },
          { name: 'spotify', version: '1.0.0', runtime_status: 'disabled' },
          { name: 'memory-x', version: '', runtime_status: 'inactive' },
          { name: 'odd', runtime_status: 'not enabled' },
          { name: 'newer', version: '2.0.0', runtime_status: 'quarantined' },
          { version: '3.0.0', runtime_status: 'enabled' }
        ],
        providers: {}
      }
    ])

    await expect(api.hub()).resolves.toEqual([
      { name: 'ergates', version: '0.2.0', runtime_status: 'enabled' },
      { name: 'spotify', version: '1.0.0', runtime_status: 'disabled' },
      { name: 'memory-x', version: null, runtime_status: 'inactive' },
      { name: 'odd', version: null, runtime_status: 'inactive' },
      { name: 'newer', version: '2.0.0', runtime_status: 'inactive' }
    ])
    expect(seen[0]).toMatchObject({ method: 'GET', path: '/api/dashboard/plugins/hub' })
  })

  it('sends the token in loopback mode and the cookie in gated mode', async () => {
    const token = await connected(() => [200, { plugins: [] }])
    await token.api.hub()
    expect(token.seen[0]!.headers['X-Hermes-Session-Token']).toBe('tok-1')

    const gated = await connected(() => [200, { plugins: [] }], 'password')
    await gated.api.hub()
    expect(gated.seen[0]!.headers.Cookie).toBe('hermes_session_at=abc')
    expect(gated.seen[0]!.headers['X-Hermes-Session-Token']).toBeUndefined()
  })

  it('loads the stored sign-in before the first call of a cold start', async () => {
    const { impl, seen } = server(() => [200, { plugins: [] }])
    const gateway = await gatewayWith(impl)

    await gateway.plugins.hub()
    expect(seen[0]!.headers['X-Hermes-Session-Token']).toBe('tok-1')
  })

  it.each([
    [401, { detail: 'Unauthorized' }, 'unauthorized'],
    [500, { detail: 'Failed to build plugins hub.' }, 'unknown']
  ] as const)('rejects a %i answer', async (status, body, kind) => {
    const { api } = await connected(() => [status, body])

    const err = await rejection(api.hub())
    expect(err).toMatchObject({ kind, status })
    expect(err.code).toBeUndefined()
  })

  it('rejects a 200 answer that holds no plugin list', async () => {
    const { api } = await connected(() => [200, '<html>Hermes</html>'])

    await expect(rejection(api.hub())).resolves.toMatchObject({ kind: 'unknown', status: 200 })
    const { api: other } = await connected(() => [200, { providers: {} }])
    await expect(rejection(other.hub())).resolves.toMatchObject({ kind: 'unknown', status: 200 })
  })
})

describe('PluginsApi over the real gateway: enable', () => {
  it('posts to the enable route of the named plugin, with no body', async () => {
    const { api, seen } = await connected(() => [200, { ok: true, name: 'ergates', unchanged: false }])

    await expect(api.enable('ergates')).resolves.toBeUndefined()
    expect(seen[0]).toMatchObject({ method: 'POST', path: '/api/dashboard/agent-plugins/ergates/enable', body: undefined })
    expect(seen[0]!.headers['X-Hermes-Session-Token']).toBe('tok-1')
  })

  it('sends the cookie in gated mode', async () => {
    const { api, seen } = await connected(() => [200, { ok: true }], 'password')

    await api.enable('ergates')
    expect(seen[0]!.headers.Cookie).toBe('hermes_session_at=abc')
  })

  it('maps no code from any refusal, even one worded like an install failure', async () => {
    const { api } = await connected(() => [400, { detail: 'enable refused: the plugin asks for a capability that is not allowed' }])

    const err = await rejection(api.enable('ergates'))
    expect(err).toMatchObject({ kind: 'unknown', status: 400, message: 'enable refused: the plugin asks for a capability that is not allowed' })
    expect(err.code).toBeUndefined()
  })

  it('rejects a plugin Hermes does not know with its detail', async () => {
    const { api } = await connected(() => [400, { detail: "Plugin 'ergates' is not installed or bundled." }])

    await expect(rejection(api.enable('ergates'))).resolves.toMatchObject({ kind: 'unknown', status: 400, message: "Plugin 'ergates' is not installed or bundled." })
  })

  it('rejects an expired sign-in', async () => {
    const { api } = await connected(() => [401, { detail: 'Unauthorized' }])

    await expect(rejection(api.enable('ergates'))).resolves.toMatchObject({ kind: 'unauthorized', status: 401 })
  })
})

describe('PluginsApi over the real gateway: disable', () => {
  it('posts to the disable route of the named plugin, with no body', async () => {
    const { api, seen } = await connected(() => [200, { ok: true, name: 'ergates', unchanged: false, restart_required: true }])

    await expect(api.disable('ergates')).resolves.toBeUndefined()
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ method: 'POST', path: '/api/dashboard/agent-plugins/ergates/disable', body: undefined })
    expect(seen[0]!.headers['X-Hermes-Session-Token']).toBe('tok-1')
  })

  it('sends the cookie in gated mode', async () => {
    const { api, seen } = await connected(() => [200, { ok: true }], 'password')

    await api.disable('ergates')
    expect(seen[0]!.headers.Cookie).toBe('hermes_session_at=abc')
    expect(seen[0]!.headers['X-Hermes-Session-Token']).toBeUndefined()
  })

  it('treats a plugin that was already off as done', async () => {
    const { api } = await connected(() => [200, { ok: true, name: 'ergates', unchanged: true, restart_required: false }])

    await expect(api.disable('ergates')).resolves.toBeUndefined()
  })

  it('maps no code from any refusal, even one worded like an install failure', async () => {
    const { api } = await connected(() => [400, { detail: 'enable refused: the plugin asks for a capability that is not allowed' }])

    const err = await rejection(api.disable('ergates'))
    expect(err).toMatchObject({ kind: 'unknown', status: 400, message: 'enable refused: the plugin asks for a capability that is not allowed' })
    expect(err.code).toBeUndefined()
  })

  it('rejects a plugin Hermes does not know with its detail', async () => {
    const { api } = await connected(() => [400, { detail: "Plugin 'ergates' is not installed or bundled." }])

    await expect(rejection(api.disable('ergates'))).resolves.toMatchObject({ kind: 'unknown', status: 400, message: "Plugin 'ergates' is not installed or bundled." })
  })

  it('rejects an expired sign-in', async () => {
    const { api } = await connected(() => [401, { detail: 'Unauthorized' }])

    await expect(rejection(api.disable('ergates'))).resolves.toMatchObject({ kind: 'unauthorized', status: 401 })
  })
})

describe('PluginsApi over the real gateway: install', () => {
  it('sends exactly the request and resolves the plugin name and whether it is enabled', async () => {
    const { api, seen } = await connected(() => [
      200,
      { ok: true, plugin_name: 'ergates', warnings: [], python_dependencies: [], missing_env: [], enabled: true, activation: 'live', known_issues: [] }
    ])

    await expect(api.install(request)).resolves.toEqual({ plugin_name: 'ergates', enabled: true })
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ method: 'POST', path: INSTALL_PATH, body: request })
    expect(seen[0]!.headers['X-Hermes-Session-Token']).toBe('tok-1')
  })

  it('sends force: true when the request asks for it', async () => {
    const { api, seen } = await connected(() => [200, { ok: true, plugin_name: 'ergates', enabled: true }])
    const forced: PluginInstallRequest = { ...request, force: true }

    await expect(api.install(forced)).resolves.toEqual({ plugin_name: 'ergates', enabled: true })
    expect(seen[0]).toMatchObject({ method: 'POST', path: INSTALL_PATH, body: forced })
  })

  it('maps no code from Hermes\'s refusal to replace a plugin that is turned on', async () => {
    const detail =
      "Plugin 'ergates' was not published: Reinstall declined: dependency install skipped (non-interactive). The installed plugin and active environment are unchanged."
    const { api } = await connected(() => [400, { detail }])

    const err = await rejection(api.install({ ...request, force: true }))
    expect(err).toMatchObject({ kind: 'unknown', status: 400, message: detail.slice(0, 200) })
    expect(err.code).toBeUndefined()
  })

  it('sends the cookie in gated mode', async () => {
    const { api, seen } = await connected(() => [200, { ok: true, plugin_name: 'ergates', enabled: true }], 'password')

    await api.install(request)
    expect(seen[0]!.headers.Cookie).toBe('hermes_session_at=abc')
    expect(seen[0]!.headers['X-Hermes-Session-Token']).toBeUndefined()
  })

  it('rejects a 200 answer that names no plugin', async () => {
    const { api } = await connected(() => [200, { consent_required: true }])

    await expect(rejection(api.install(request))).resolves.toMatchObject({ kind: 'unknown', status: 200 })
  })

  it('gives the install 15 minutes: three git phases of 300 seconds', async () => {
    vi.useFakeTimers()
    // Never answers; rejects only when its signal aborts.
    const impl = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
        })
    ) as unknown as typeof fetch
    const gateway = await gatewayWith(impl)
    await gateway.restore()

    let settled: unknown = 'pending'
    void gateway.plugins.install(request).then(
      () => {
        settled = 'resolved'
      },
      (err: unknown) => {
        settled = err
      }
    )
    await vi.advanceTimersByTimeAsync(PLUGIN_INSTALL_TIMEOUT_MS - 1)
    expect(settled).toBe('pending')
    await vi.advanceTimersByTimeAsync(1)
    expect(settled).toMatchObject({ kind: 'timeout' })
    expect(PLUGIN_INSTALL_TIMEOUT_MS).toBe(900_000)
  })

  it('rejects with the network kind when the connection dies mid-install', async () => {
    const impl = vi.fn(async () => {
      throw new TypeError('Network request failed')
    }) as unknown as typeof fetch
    const gateway = await gatewayWith(impl)

    await expect(rejection(gateway.plugins.install(request))).resolves.toMatchObject({ kind: 'network' })
  })

  it('rejects an expired sign-in', async () => {
    const { api } = await connected(() => [401, { detail: 'Unauthorized' }])

    const err = await rejection(api.install(request))
    expect(err).toMatchObject({ kind: 'unauthorized', status: 401 })
    expect(err.code).toBeUndefined()
  })

  it('knows exactly the failure codes the app handles', () => {
    expect(Object.keys(messages.install).sort()).toEqual(['already_installed', 'download_failed', 'enable_refused', 'no_git', 'scan_blocked'])
    expect(Object.keys(FAILURES).sort()).toEqual(Object.keys(messages.install).sort())
  })

  it.each(Object.entries(FAILURES).flatMap(([code, details]) => details.map(detail => [code, detail] as const)))('maps the Hermes failure for %s: %s', async (code, detail) => {
    const { api } = await connected(() => [400, { detail }])

    const err = await rejection(api.install(request))
    expect(err).toMatchObject({ kind: 'unknown', status: 400, code })
    expect(err.message).toBe(detail.slice(0, 200))
  })

  it('maps every prefix in the messages file to its code', async () => {
    for (const [code, prefixes] of Object.entries(messages.install)) {
      for (const prefix of prefixes) {
        const { api } = await connected(() => [400, { detail: `${prefix} and what follows` }])
        await expect(rejection(api.install(request))).resolves.toMatchObject({ code })
      }
    }
  })

  it('gives a 400 that matches no prefix no code, and its detail as the message', async () => {
    const { api } = await connected(() => [400, { detail: "Invalid plugin identifier: 'x'" }])

    const err = await rejection(api.install(request))
    expect(err).toMatchObject({ kind: 'unknown', status: 400, message: "Invalid plugin identifier: 'x'" })
    expect(err.code).toBeUndefined()
  })

  it('matches a prefix only at the start of the detail', async () => {
    const { api } = await connected(() => [400, { detail: 'Install failed: git is not installed or not in PATH.' }])

    const err = await rejection(api.install(request))
    expect(err.code).toBeUndefined()
  })

  it('gives a failure answer that is not a 400 no code, even with a Hermes text', async () => {
    const { api } = await connected(() => [500, { detail: 'git is not installed or not in PATH.' }])

    const err = await rejection(api.install(request))
    expect(err).toMatchObject({ kind: 'unknown', status: 500 })
    expect(err.code).toBeUndefined()
  })

  it('keeps at most 200 characters of a long detail and redacts secrets in it', async () => {
    const detail = `Could not download the plugin from https://example.org/x?token=abc123 ${'x'.repeat(400)}`
    const { api } = await connected(() => [400, { detail }])

    const err = await rejection(api.install(request))
    expect(err.code).toBe('download_failed')
    expect(err.message.length).toBeLessThanOrEqual(200)
    expect(err.message).toContain('token=<redacted>')
    expect(err.message).not.toContain('abc123')
  })

  it('redacts secrets in a detail with no code as well', async () => {
    const { api } = await connected(() => [400, { detail: 'Invalid plugin identifier: https://x.test/?ticket=zzz' }])

    const err = await rejection(api.install(request))
    expect(err.code).toBeUndefined()
    expect(err.message).toBe('Invalid plugin identifier: https://x.test/?ticket=<redacted>')
  })

  it('falls back to a plain message for a 400 with no detail', async () => {
    const { api } = await connected(() => [400, undefined])

    const err = await rejection(api.install(request))
    expect(err).toMatchObject({ kind: 'unknown', status: 400, message: 'Request failed (400).' })
    expect(err.code).toBeUndefined()
  })
})
