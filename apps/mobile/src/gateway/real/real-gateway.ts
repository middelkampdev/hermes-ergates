/**
 * RealGateway: GatewayPort over `hermes serve` REST + JSON-RPC.
 *
 * Profile-level RPCs use a control socket on the `default` profile; session
 * RPCs use the socket of the profile that owns the session (events route to
 * the transport that created or resumed the session).
 */

import type { WebSocketLike } from '@vendor/hermes/shared/json-rpc-gateway'

import { GatewayError, isGatewayError } from '../errors'
import type { ErgatesApi, FilesApi, GatewayConnection, GatewayPort, ProfilesApi, RoutinesApi, SessionsApi, ToolsApi } from '../port'
import { normalizeTranscriptPage } from '../transcript'
import type * as T from '../types'
import { logoutRequest, mintTicket, passwordLogin, readStatus, whoAmI } from './auth'
import { createErgatesApi } from './ergates-api'
import { HttpClient, type HttpAuthMode, type HttpAuthState } from './http'
import type { SecretStore } from './secrets'
import { SocketSession, type SocketCredential } from './socket'

export interface RealGatewayOptions {
  connectionId: string
  baseUrl: string
  secrets: SecretStore
  fetchImpl?: typeof fetch
  socketFactory?: (url: string) => WebSocketLike
}

const CONTROL_PROFILE = 'default'

/** The slice of `@react-native-cookies/cookies` this adapter uses. */
interface CookieJar {
  get(url: string, useWebKit?: boolean): Promise<Record<string, unknown>>
  clearByName(url: string, name: string, useWebKit?: boolean): Promise<boolean>
  clearAll?(useWebKit?: boolean): Promise<boolean>
  flush?(): Promise<void>
}

export class RealGateway implements GatewayPort {
  readonly connectionId: string
  readonly http: HttpClient
  /** The Ergates integration routes, over this connection's auth. */
  readonly ergates: ErgatesApi
  private readonly options: RealGatewayOptions
  private auth: HttpAuthState = { mode: 'none' }
  private authLoaded: Promise<void> | null = null
  private readonly sockets = new Map<string, Promise<SocketSession>>()
  private readonly sessionOwner = new Map<string, string>()
  private profilePaths = new Map<string, string>()

  constructor(options: RealGatewayOptions) {
    this.options = options
    this.connectionId = options.connectionId
    this.http = new HttpClient({
      baseUrl: options.baseUrl,
      getAuth: () => this.auth,
      onSetCookie: cookie => {
        this.auth = { ...this.auth, cookie }
        void options.secrets.set(this.key('cookie'), cookie)
      },
      fetchImpl: options.fetchImpl
    })
    this.ergates = createErgatesApi(this.http, () => this.restore())
  }

  private key(kind: 'token' | 'cookie' | 'mode'): string {
    return `ergates.${this.connectionId}.${kind}`
  }

  /** Restore persisted auth material once per instance. */
  async restore(): Promise<HttpAuthMode> {
    if (!this.authLoaded) {
      this.authLoaded = (async () => {
        const [mode, token, cookie] = await Promise.all([
          this.options.secrets.get(this.key('mode')),
          this.options.secrets.get(this.key('token')),
          this.options.secrets.get(this.key('cookie'))
        ])
        if (mode === 'token' && token) {
          this.auth = { mode: 'token', token }
        } else if (mode === 'password' && cookie) {
          this.auth = { mode: 'password', cookie }
        } else {
          this.auth = { mode: 'none' }
        }
      })()
    }
    await this.authLoaded
    return this.auth.mode
  }

  get authMode(): HttpAuthMode {
    return this.auth.mode
  }

  // ── auth ───────────────────────────────────────────────────────────────

  status(): Promise<T.BackendStatus> {
    return readStatus(this.http)
  }

  async login(creds: T.Credentials): Promise<T.AuthIdentity | null> {
    const previous = this.auth
    if (creds.mode === 'token') {
      this.auth = { mode: 'token', token: creds.token }
      try {
        // Probe: the roster route is gated by the token in plain mode.
        await this.http.get('/api/profiles')
      } catch (err) {
        // Roll back: a rejected token must not leave the client half-authenticated.
        this.auth = previous
        throw err
      }
      await this.options.secrets.set(this.key('mode'), 'token')
      await this.options.secrets.set(this.key('token'), creds.token)
      return null
    }
    this.auth = { mode: 'password', cookie: null }
    try {
      await passwordLogin(this.http, creds)
      if (!this.auth.cookie) {
        throw new GatewayError('unauthorized', 'The gateway did not return a session cookie.')
      }
      await this.options.secrets.set(this.key('mode'), 'password')
      await this.options.secrets.set(this.key('cookie'), this.auth.cookie)
      return await whoAmI(this.http)
    } catch (err) {
      // `onSetCookie` writes any `Set-Cookie` it sees, including one from a login
      // that then fails. The caller discards this connection id, so nothing would
      // ever be able to target that entry again: clear all three here.
      this.auth = previous
      await this.forgetSecrets()
      await this.clearCookies()
      throw err
    }
  }

  private async forgetSecrets(): Promise<void> {
    await Promise.all([
      this.options.secrets.remove(this.key('mode')),
      this.options.secrets.remove(this.key('token')),
      this.options.secrets.remove(this.key('cookie'))
    ]).catch(() => undefined)
  }

  /**
   * Clear the platform cookie jar for this gateway's origin.
   *
   * Requests skip the jar (`credentials: 'omit'` in http.ts), so it no longer
   * authenticates anything. This stays to clear jars that older app versions
   * filled. `POST /auth/logout` is best-effort (offline sign-out, already-401
   * session), so a leftover session cookie would otherwise survive sign-out and
   * connection removal (docs/04 section 6, ADR-028).
   *
   * The module is imported lazily: it pulls in react-native, which a plain
   * Node/vitest run cannot parse.
   */
  async clearCookies(): Promise<void> {
    this.auth = { ...this.auth, cookie: null }
    try {
      const imported = (await import('@react-native-cookies/cookies')) as unknown as { default?: CookieJar } & Partial<CookieJar>
      const jar = (imported.default ?? imported) as CookieJar
      const origin = this.http.baseUrl
      const cookies = await jar.get(origin)
      const names = Object.keys(cookies ?? {})
      for (const name of names) {
        await jar.clearByName(origin, name)
      }
      await jar.flush?.()
    } catch {
      // No native module (Expo Go, a Node test) or a jar that refuses per-name
      // clears: the SecureStore copy is already gone, which is the part this
      // process controls.
    }
  }

  async me(): Promise<T.AuthIdentity | null> {
    await this.restore()
    if (this.auth.mode === 'password') {
      return whoAmI(this.http)
    }
    return null
  }

  async logout(): Promise<void> {
    const wasPassword = this.auth.mode === 'password'
    if (wasPassword) {
      await logoutRequest(this.http)
    }
    this.disconnectAll()
    if (wasPassword) {
      // After the best-effort revoke, and regardless of whether it worked.
      await this.clearCookies()
    }
    this.auth = { mode: 'none' }
    await this.forgetSecrets()
  }

  private async credential(): Promise<SocketCredential> {
    await this.restore()
    if (this.auth.mode === 'token' && this.auth.token) {
      return { token: this.auth.token }
    }
    if (this.auth.mode === 'password') {
      return { ticket: await mintTicket(this.http) }
    }
    throw new GatewayError('unauthorized', 'Sign-in required.')
  }

  // ── sockets ────────────────────────────────────────────────────────────

  connect(profile: string): Promise<GatewayConnection> {
    return this.socket(profile)
  }

  private socket(profile: string): Promise<SocketSession> {
    const existing = this.sockets.get(profile)
    if (existing) {
      return existing
    }
    const opening = SocketSession.open({
      baseUrl: this.http.baseUrl,
      profile,
      credential: () => this.credential(),
      socketFactory: this.options.socketFactory,
      // A socket that opened and then failed terminally (4401/4403/4404, or a
      // credential that stopped authenticating) must not stay cached: every later
      // connect(profile) would hand out the same dead promise, so the connection
      // stayed bricked until the process restarted — even after a re-login.
      onTerminal: () => this.evict(profile)
    })
    this.sockets.set(profile, opening)
    opening.catch(() => this.sockets.delete(profile))
    return opening
  }

  /**
   * Drop a socket from the cache without closing it: its owner may still read
   * `lastError` to offer re-authentication. `sessionOwner` is kept — the profile
   * that owns a session does not change, and the next RPC rebuilds the socket.
   */
  private evict(profile: string): void {
    this.sockets.delete(profile)
  }

  private control(): Promise<SocketSession> {
    return this.socket(CONTROL_PROFILE)
  }

  private async sessionSocket(sessionId: string): Promise<SocketSession> {
    const owner = this.sessionOwner.get(sessionId) ?? CONTROL_PROFILE
    return this.socket(owner)
  }

  disconnectAll(): void {
    for (const pending of this.sockets.values()) {
      pending.then(s => s.close()).catch(() => undefined)
    }
    this.sockets.clear()
    this.sessionOwner.clear()
  }

  // ── profiles ───────────────────────────────────────────────────────────

  readonly profiles: ProfilesApi = {
    list: async () => {
      const c = await this.control()
      const result = await c.request<T.ProfilesListResult>('profiles.list', {})
      const paths = new Map<string, string>()
      for (const p of result.profiles ?? []) {
        if (p.path) {
          paths.set(p.name, p.path)
        }
      }
      this.profilePaths = paths
      return result
    },
    describe: async name => {
      const c = await this.control()
      return c.request<T.ProfileDescribe>('profiles.describe', { name })
    },
    configure: async params => {
      const c = await this.control()
      return c.request<T.ConfigureResult>('profiles.configure', params as unknown as Record<string, unknown>)
    },
    create: async params => {
      const c = await this.control()
      return c.request<unknown>('profiles.create', params as unknown as Record<string, unknown>, 120_000)
    },
    remove: async name => {
      await this.http.delete(`/api/profiles/${encodeURIComponent(name)}`)
      const pending = this.sockets.get(name)
      if (pending) {
        pending.then(s => s.close()).catch(() => undefined)
        this.sockets.delete(name)
      }
    },
    getAsset: async name => {
      const c = await this.control()
      return c.request<T.AssetResult>('profiles.get_asset', { name, asset: 'avatar' })
    },
    setAsset: async (name, dataUrl) => {
      const c = await this.control()
      await c.request('profiles.set_asset', dataUrl === null ? { name, asset: 'avatar', clear: true } : { name, asset: 'avatar', data: dataUrl })
    },
    modelOptions: async profile => {
      const c = await this.control()
      return c.request<T.ModelOptions>('model.options', { profile, include_unconfigured: true, explicit_only: false }, 60_000)
    },
    memory: async name => {
      let path = this.profilePaths.get(name)
      if (!path) {
        await this.profiles.list()
        path = this.profilePaths.get(name)
      }
      if (!path) {
        return { memory: '', user: '', available: false }
      }
      const read = async (file: string): Promise<string | null> => {
        try {
          const res = await this.http.get<{ text?: string }>(`/api/fs/read-text?path=${encodeURIComponent(`${path}/memories/${file}`)}`)
          return typeof res?.text === 'string' ? res.text : ''
        } catch (err) {
          if (isGatewayError(err) && err.kind === 'not_found') {
            return ''
          }
          return null
        }
      }
      const [memory, user] = await Promise.all([read('MEMORY.md'), read('USER.md')])
      if (memory === null && user === null) {
        return { memory: '', user: '', available: false }
      }
      return { memory: memory ?? '', user: user ?? '', available: true }
    }
  }

  // ── sessions ───────────────────────────────────────────────────────────

  readonly sessions: SessionsApi = {
    list: async params => {
      const c = await this.socket(params.profile ?? CONTROL_PROFILE)
      return c.request<{ sessions: T.SessionRow[] }>('session.list', params)
    },
    create: async params => {
      const c = await this.socket(params.profile)
      const result = await c.request<T.SessionCreateResult>('session.create', { ...params, source: 'mobile', cols: 80 })
      this.sessionOwner.set(result.session_id, params.profile)
      return result
    },
    resume: async params => {
      const profile = params.profile ?? CONTROL_PROFILE
      const c = await this.socket(profile)
      const result = await c.request<T.SessionResumeResult>('session.resume', { session_id: params.session_id, profile, cols: 80, source: 'mobile' }, 90_000)
      this.sessionOwner.set(result.session_id, profile)
      return result
    },
    activate: async (liveSessionId, opts) => {
      const c = await this.sessionSocket(liveSessionId)
      // omit_messages skips the durable history read: the transport rebind is what
      // this call is for, and the transcript comes from session.history when needed.
      return c.request<T.ActivateResult>('session.activate', { session_id: liveSessionId, omit_messages: opts?.omit_messages ?? true }, 30_000)
    },
    title: async (liveSessionId, title) => {
      const c = await this.sessionSocket(liveSessionId)
      return c.request<T.TitleResult>('session.title', { session_id: liveSessionId, title }, 30_000)
    },
    history: async sessionId => {
      const c = await this.sessionSocket(sessionId)
      return c.request<T.HistoryResult>('session.history', { session_id: sessionId }, 60_000)
    },
    transcript: async (sessionId, opts) => {
      const qs = new URLSearchParams({ profile: opts.profile, limit: String(Math.min(Math.max(opts.limit, 1), 500)), offset: String(opts.offset ?? 0), order: opts.order })
      if (opts.includeCompacted) qs.set('include_compacted', 'true')
      const raw = await this.http.get<T.TranscriptRawPage>(`/api/sessions/${encodeURIComponent(sessionId)}/messages?${qs.toString()}`)
      return normalizeTranscriptPage(raw)
    },
    submit: async (sessionId, text, opts) => {
      const c = await this.sessionSocket(sessionId)
      const params: Record<string, unknown> = { session_id: sessionId, text }
      if (opts?.queued) {
        params.queued = true
      }
      return c.request<T.SubmitResult>('prompt.submit', params, 120_000)
    },
    interrupt: async sessionId => {
      const c = await this.sessionSocket(sessionId)
      return c.request<T.InterruptResult>('session.interrupt', { session_id: sessionId })
    },
    steer: async (sessionId, text) => {
      const c = await this.sessionSocket(sessionId)
      return c.request<T.SteerResult>('session.steer', { session_id: sessionId, text })
    },
    usage: async sessionId => {
      const c = await this.sessionSocket(sessionId)
      return c.request<T.UsagePayload>('session.usage', { session_id: sessionId })
    },
    respondApproval: async p => {
      const c = await this.sessionSocket(p.session_id)
      await c.request('approval.respond', { session_id: p.session_id, request_id: p.request_id, choice: p.choice })
    },
    respondClarify: async p => {
      const c = await this.sessionSocket(p.session_id)
      const params: Record<string, unknown> = { session_id: p.session_id, request_id: p.request_id, answer: p.answer }
      if (p.question_id) {
        params.question_id = p.question_id
      }
      return c.request<{ status: string; remaining?: string[] }>('clarify.respond', params)
    },
    attachImageBytes: async p => {
      const c = await this.sessionSocket(p.session_id)
      return c.request('image.attach_bytes', p as unknown as Record<string, unknown>, 120_000)
    },
    attachFile: async p => {
      const c = await this.sessionSocket(p.session_id)
      return c.request<{ attached?: boolean; name?: string; path?: string; ref_text?: string }>('file.attach', p as unknown as Record<string, unknown>, 120_000)
    },
    close: async sessionId => {
      const c = await this.sessionSocket(sessionId)
      await c.request('session.close', { session_id: sessionId })
      this.sessionOwner.delete(sessionId)
    },
    remove: async storedSessionId => {
      const c = await this.control()
      await c.request('session.delete', { session_id: storedSessionId })
    }
  }

  // ── routines ───────────────────────────────────────────────────────────

  readonly routines: RoutinesApi = {
    list: async profile => {
      const c = await this.control()
      const res = await c.request<{ jobs?: T.CronJob[]; scoped?: string }>('cron.manage', { action: 'list', include_disabled: true, profile })
      const jobs = (res.jobs ?? []).map(normalizeCronJob)
      return res.scoped ? jobs.map(j => ({ ...j, profile: j.profile ?? profile })) : jobs
    },
    create: async (profile, body) => {
      const c = await this.control()
      const res = await c.request<Record<string, unknown>>('cron.manage', { action: 'add', profile, ...body })
      return normalizeCronJob((res.job as Record<string, unknown>) ?? res)
    },
    update: async (id, updates, profile) => {
      return this.http.put<T.CronJob>(`/api/cron/jobs/${encodeURIComponent(id)}${profileQuery(profile)}`, { updates })
    },
    pause: async (id, profile) => {
      const c = await this.control()
      await c.request('cron.manage', { action: 'pause', name: id, ...(profile ? { profile } : {}) })
    },
    resume: async (id, profile) => {
      const c = await this.control()
      await c.request('cron.manage', { action: 'resume', name: id, ...(profile ? { profile } : {}) })
    },
    trigger: async (id, profile) => {
      await this.http.post(`/api/cron/jobs/${encodeURIComponent(id)}/trigger${profileQuery(profile)}`)
    },
    remove: async (id, profile) => {
      const c = await this.control()
      await c.request('cron.manage', { action: 'remove', name: id, ...(profile ? { profile } : {}) })
    },
    runs: async (id, profile) => {
      const res = await this.http.get<{ runs?: T.CronRun[] }>(`/api/cron/jobs/${encodeURIComponent(id)}/runs${profileQuery(profile, { limit: '20' })}`)
      return res.runs ?? []
    }
  }

  // ── tools ──────────────────────────────────────────────────────────────

  readonly tools: ToolsApi = {
    toolsets: async profile => this.http.get<T.Toolset[]>(`/api/tools/toolsets${profileQuery(profile)}`),
    skills: async profile => this.http.get<T.SkillRow[]>(`/api/skills${profileQuery(profile)}`),
    mcpServers: async profile => {
      const res = await this.http.get<{ servers?: T.McpServerRow[] }>(`/api/mcp/servers${profileQuery(profile)}`)
      return res.servers ?? []
    },
    testMcp: async (name, profile) => this.http.post<{ ok: boolean }>(`/api/mcp/servers/${encodeURIComponent(name)}/test${profileQuery(profile)}`)
  }

  // ── files ──────────────────────────────────────────────────────────────

  readonly files: FilesApi = {
    uploadImage: async (profile, dataUrl, filename) =>
      this.http.post<T.ImageUploadResult>(`/api/chat/image-upload${profileQuery(profile)}`, { data_url: dataUrl, filename }),
    uploadFile: async (path, dataUrl) => this.http.post<T.FileUploadResult>('/api/files/upload', { path, data_url: dataUrl, overwrite: false })
  }
}

function profileQuery(profile?: string, extra: Record<string, string> = {}): string {
  const qs = new URLSearchParams(extra)
  if (profile) {
    qs.set('profile', profile)
  }
  const s = qs.toString()
  return s ? `?${s}` : ''
}

/** `cron.manage` rows key the id as `job_id`; REST rows use `id`. Normalize to the port shape. */
export function normalizeCronJob(raw: Record<string, unknown>): T.CronJob {
  const id = String(raw.id ?? raw.job_id ?? '')
  const schedule = raw.schedule
  const scheduleText = typeof schedule === 'string' ? schedule : typeof (raw.schedule_display) === 'string' ? (raw.schedule_display as string) : schedule && typeof schedule === 'object' && typeof (schedule as { display?: unknown }).display === 'string' ? (schedule as { display: string }).display : ''
  const paused = raw.paused === true || raw.state === 'paused' || raw.enabled === false
  return {
    ...(raw as T.CronJob),
    id,
    name: String(raw.name ?? ''),
    schedule: scheduleText,
    prompt: typeof raw.prompt === 'string' ? raw.prompt : typeof raw.prompt_preview === 'string' ? raw.prompt_preview : undefined,
    enabled: raw.enabled === undefined ? !paused : Boolean(raw.enabled),
    paused,
    next_run: (raw.next_run ?? raw.next_run_at ?? null) as T.CronJob['next_run'],
    last_run: (raw.last_run ?? raw.last_run_at ?? null) as T.CronJob['last_run']
  }
}
