/**
 * FakeGateway: an in-memory GatewayPort double driven by a small script.
 *
 * It mimics the recorded backend shapes closely enough for scenario tests to
 * drive the real `createSessionController` without a network. Every
 * profile/session RPC is answered from `test/fixtures/*.json`
 * (see docs/06-hermes-api-contract.md for the backend wire shapes);
 * only `prompt.submit` and replay are scriptable per test.
 *
 * No React Native or Expo imports (ADR-029 rule 1) - this runs in Node under
 * Vitest.
 */

import { GatewayError, requireSent, type RespondOutcome } from '@/gateway/errors'
import type { ConnectionFailure, ConnectionState, FilesApi, GatewayConnection, GatewayPort, ProfilesApi, RoutinesApi, SessionsApi, ToolsApi } from '@/gateway/port'
import { normalizeTranscriptPage } from '@/gateway/transcript'
import type * as T from '@/gateway/types'

import assetAvatarFixture from '../fixtures/asset-avatar.json'
import cronJobsFixture from '../fixtures/cron-jobs.json'
import historyFixture from '../fixtures/history.json'
import mcpServersFixture from '../fixtures/mcp-servers.json'
import modelOptionsFixture from '../fixtures/model-options.json'
import profilesDescribeFixture from '../fixtures/profiles-describe.json'
import profilesListFixture from '../fixtures/profiles-list.json'
import sessionCreateFixture from '../fixtures/session-create.json'
import skillsFixture from '../fixtures/skills.json'
import statusFixture from '../fixtures/status.json'
import toolsetsFixture from '../fixtures/toolsets.json'
import transcriptSenderFixture from '../fixtures/agent-traffic/transcript-sender.json'

import { FakeErgates } from './fake-ergates'
import { FakePlugins } from './fake-plugins'

/** Deep-clones a fixture and casts it to the wire type it represents. */
const clone = <V>(value: unknown): V => structuredClone(value) as V

/**
 * Default `sessions.transcript` answer: `transcript-sender.json` sliced by
 * offset/limit like the real REST route, counted from the newest end when
 * `order === 'latest'` and from the oldest end for `'oldest'`, then returned
 * in ascending id order.
 */
function defaultTranscriptPage(sessionId: string, opts: T.TranscriptQuery): T.TranscriptRawPage {
  const rows = transcriptSenderFixture.messages as unknown[]
  const limit = Math.min(Math.max(opts.limit, 1), 500)
  const offset = opts.offset ?? 0
  const fromOldest = opts.order === 'oldest' ? rows : [...rows].reverse()
  const sliced = fromOldest.slice(offset, offset + limit)
  const ascending = opts.order === 'oldest' ? sliced : [...sliced].reverse()
  return {
    session_id: sessionId,
    profile: opts.profile,
    messages: ascending,
    pagination: { limit, offset, order: opts.order, returned: ascending.length }
  }
}

/**
 * What one `send()` attempt does: stream these frames, fail like the real gateway
 * would, or answer with a non-streaming status (a busy send comes back `queued`,
 * `redirected` or `steered`).
 */
export type SubmitOutcome = T.GatewayEventFrame[] | 'timeout' | 'reject' | { status: T.SubmitResult['status']; events?: T.GatewayEventFrame[] }

export interface FakeScript {
  /** A returned promise keeps that `prompt.submit` in flight until it settles. */
  onSubmit?: (text: string) => SubmitOutcome | Promise<SubmitOutcome>
  /** Overrides merged onto the default (gap-since-lastSeen) replay result. */
  replay?: Partial<T.ReplayResult>
  readyEpoch?: string
  /** Rows the exact-title `session.list` lookup answers with. */
  sessions?: T.SessionRow[]
  /** Overrides merged onto the default `session.activate` result. */
  activate?: Partial<T.ActivateResult>
  /** Reject `session.activate` this many times with 4009 before answering. */
  activateSettling?: number
  /** Reject `session.title` with a uniqueness error (the adopt-before-mint path). */
  titleConflict?: boolean
  /** Reject `session.history` this many times before answering. */
  historyFailures?: number
  /**
   * Answers the Nth (1-based) `session.history` call. It is awaited, so a test can
   * hold one snapshot in flight while events land; `undefined` falls back to the
   * recorded fixture.
   */
  history?: (call: number) => Promise<T.HistoryMessage[] | undefined> | T.HistoryMessage[] | undefined
  /** Overrides the default (sliced `transcript-sender.json`) `sessions.transcript` answer. */
  transcript?: (opts: T.TranscriptQuery & { sessionId: string }) => T.TranscriptRawPage | 'reject'
}

/**
 * One live connection for one profile. `emit`, `serverRequest`,
 * `cancelRequest` and `simulateDrop` are test-only hooks (not part of
 * `GatewayConnection`) reached via `FakeGateway.connectionFor`.
 */
export class FakeConnection implements GatewayConnection {
  readonly profile: string
  readonly ready: T.GatewayReadyPayload
  /** Count of `prompt.submit` requests this connection has answered. */
  submitCalls = 0
  /** Every RPC this connection saw, in order: `[method, params]`. */
  readonly requests: { method: string; params: Record<string, unknown> }[] = []
  /** Every answer to a server request that went out, in order. */
  readonly responses: { id: string; result: Record<string, unknown> }[] = []
  lastError: ConnectionFailure | null = null

  private readonly script: FakeScript
  private stateValue: ConnectionState = 'open'
  private readonly eventHandlers = new Set<(event: T.GatewayEventFrame) => void>()
  private readonly stateHandlers = new Set<(state: ConnectionState) => void>()
  private readonly requestHandlers = new Set<(request: T.ServerRequestFrame) => void>()
  /** The server requests Hermes still waits on, by id, oldest first (server_requests.py:337-341). */
  private readonly openRequests = new Map<string, T.OpenServerRequest>()
  private readonly log: T.GatewayEventFrame[] = []
  private seqCounter = 1000
  /** Rejecters of the requests still waiting for an answer. */
  private readonly inFlight = new Set<(err: Error) => void>()

  constructor(profile: string, script: FakeScript) {
    this.profile = profile
    this.script = script
    this.ready = { heartbeat: true, change_events: true, replay_epoch: script.readyEpoch ?? 'epoch-fake' }
  }

  get state(): ConnectionState {
    return this.stateValue
  }

  async request<R>(method: string, params: Record<string, unknown> = {}): Promise<R> {
    // Like the vendored client (vendor/hermes/shared/json-rpc-gateway.ts, `request`):
    // a socket that is not open rejects at once and nothing reaches the server.
    if (this.stateValue !== 'open') {
      throw new GatewayError('network', 'No connection to the gateway.')
    }
    this.requests.push({ method, params })
    if (method === 'prompt.submit') {
      return this.track(this.submit(params)) as unknown as R
    }
    return {} as R
  }

  /** Settles with `work`, unless the socket closes first (see `setState`). */
  private track<V>(work: Promise<V>): Promise<V> {
    return new Promise<V>((resolve, reject) => {
      this.inFlight.add(reject)
      work.then(resolve, reject).finally(() => this.inFlight.delete(reject))
    })
  }

  /** The methods this connection saw, in order. */
  methods(): string[] {
    return this.requests.map(r => r.method)
  }

  private async submit(params: Record<string, unknown>): Promise<T.SubmitResult> {
    this.submitCalls += 1
    const sessionId = String(params.session_id ?? '')
    const text = String(params.text ?? '')
    const outcome = this.script.onSubmit ? await this.script.onSubmit(text) : []
    if (outcome === 'timeout') {
      throw new GatewayError('timeout', 'The gateway did not answer in time.')
    }
    if (outcome === 'reject') {
      throw new GatewayError('rpc', 'The gateway rejected the request.', { code: 4002 })
    }
    const status = Array.isArray(outcome) ? 'streaming' : outcome.status
    const frames = Array.isArray(outcome) ? outcome : outcome.events ?? []
    // The real gateway resolves `{status:'streaming'}` before any event is on
    // the wire; events land on their own turn of the loop.
    setTimeout(() => {
      for (const frame of frames) {
        this.emit({ session_id: sessionId, ...frame })
      }
    }, 0)
    return { status }
  }

  onEvent(handler: (event: T.GatewayEventFrame) => void): () => void {
    this.eventHandlers.add(handler)
    return () => this.eventHandlers.delete(handler)
  }

  onState(handler: (state: ConnectionState) => void): () => void {
    this.stateHandlers.add(handler)
    handler(this.stateValue)
    return () => this.stateHandlers.delete(handler)
  }

  onRequest(handler: (request: T.ServerRequestFrame) => void): () => void {
    this.requestHandlers.add(handler)
    return () => this.requestHandlers.delete(handler)
  }

  /** Like `SocketSession.respond`: nothing goes out while the socket is down or for a request Hermes no longer holds. */
  respond(requestId: string, result: Record<string, unknown>): RespondOutcome {
    if (this.stateValue !== 'open') {
      return 'offline'
    }
    if (!this.openRequests.delete(requestId)) {
      return 'unknown'
    }
    this.responses.push({ id: requestId, result: structuredClone(result) })
    return 'sent'
  }

  /** Test hook: Hermes writes a server request to this socket and waits for the answer. */
  serverRequest(request: T.OpenServerRequest): void {
    this.openRequests.set(request.id, request)
    this.deliver(request, false)
  }

  /** Test hook: the request ended without this client's answer (timeout, interrupt, session close, an `approval.respond` from another surface), so Hermes emits `request.cancel` (server_requests.py:145-146). */
  cancelRequest(id: string, reason: string): void {
    const request = this.openRequests.get(id)
    this.openRequests.delete(id)
    this.emit({ type: 'request.cancel', session_id: request?.params.session_id, seq: this.nextSeq(), payload: { id, method: request?.method ?? '', reason } })
  }

  /** The requests still open for one session, as `open_requests` lists them. */
  openRequestsFor(sessionId: string): T.OpenServerRequest[] {
    return [...this.openRequests.values()].filter(r => r.params.session_id === sessionId).map(r => structuredClone(r))
  }

  /** Like the vendored channel (json-rpc-channel.ts:413-426, 474-483): every `open_requests` entry of an answer is delivered again, before the caller sees the answer. */
  redeliver(open: T.OpenServerRequest[] | undefined): void {
    for (const request of open ?? []) {
      this.deliver(request, true)
    }
  }

  private deliver(request: T.OpenServerRequest, replayed: boolean): void {
    for (const handler of this.requestHandlers) {
      handler({ ...structuredClone(request), replayed })
    }
  }

  async replay(sessionId: string, lastSeen: number): Promise<T.ReplayResult> {
    this.requests.push({ method: 'session.events.since', params: { session_id: sessionId, last_seen: lastSeen } })
    const gap = this.log.filter(e => typeof e.seq === 'number' && e.seq > lastSeen)
    const latest = gap.reduce((max, e) => Math.max(max, e.seq ?? 0), lastSeen)
    const open = this.openRequestsFor(sessionId)
    const base: T.ReplayResult = {
      events: gap,
      latest_seq: latest,
      truncated: false,
      count: gap.length,
      epoch: this.script.readyEpoch ?? 'epoch-fake',
      // `session.events.since` lists the open requests too, even when there are none (methods_session.py:2345-2348).
      open_requests: open
    }
    const result = { ...base, ...(this.script.replay ?? {}) }
    this.redeliver(result.open_requests)
    return result
  }

  close(): void {
    this.setState('closed')
  }

  /** Test hook: push an event straight to subscribers (and the replay log). */
  emit(event: T.GatewayEventFrame): void {
    this.log.push(event)
    for (const handler of this.eventHandlers) {
      handler(event)
    }
  }

  /** Next seq for events the fake synthesizes itself (well above script seqs). */
  nextSeq(): number {
    this.seqCounter += 1
    return this.seqCounter
  }

  /** Test hook: a brief transport blip - closed (in-flight requests fail), then open again. */
  simulateDrop(): void {
    this.setState('closed')
    this.setState('open')
  }

  /** Test hook: the socket is down until `simulateOnline`; in-flight requests fail. */
  simulateOffline(): void {
    this.setState('closed')
  }

  /** Test hook: the socket is back after `simulateOffline`. */
  simulateOnline(): void {
    this.setState('open')
  }

  private setState(state: ConnectionState): void {
    this.stateValue = state
    for (const handler of this.stateHandlers) {
      handler(state)
    }
    if (state === 'closed') {
      // Like the real client (vendor/hermes/shared/json-rpc-gateway.ts, `close`
      // and the socket's close listener): a closed socket rejects every request
      // still in flight, and the adapter maps that to a `network` error.
      const pending = [...this.inFlight]
      this.inFlight.clear()
      for (const reject of pending) {
        reject(new GatewayError('network', 'No connection to the gateway.'))
      }
    }
  }
}

export class FakeGateway implements GatewayPort {
  private readonly script: FakeScript
  private readonly connections = new Map<string, FakeConnection>()
  /** live session id -> owning profile, set on session.create/resume. */
  private readonly sessionOwner = new Map<string, string>()

  /** The profiles this gateway has: the recorded roster, plus any `profiles.create` made. */
  readonly profileNames = new Set<string>((profilesListFixture.profiles as { name: string }[]).map(p => p.name))
  /** The Ergates routes, over this gateway's profiles. */
  readonly ergates = new FakeErgates({ hasProfile: name => this.profileNames.has(name), installedCommit: () => this.plugins.installedCommit })
  /** Hermes's plugin routes: the hub list, install, enable and disable. */
  readonly plugins = new FakePlugins()

  /** `ui_meta` and its revisions per profile once a write touched them, as profile.yaml holds them. */
  private readonly storedMeta = new Map<string, { uiMeta: T.UiMeta; revisions: Record<string, number> }>()
  /** Every `profiles.configure` call, in order. */
  readonly configureCalls: T.ConfigureParams[] = []
  /** Test hook: runs before each `profiles.configure` is applied, e.g. to let Hermes Desktop write in between. */
  beforeConfigure: ((params: T.ConfigureParams) => void) | null = null
  /** Test hook: while true, `profiles.list` and `profiles.configure` fail like a lost connection. */
  profilesOffline = false
  /** What `setHermesVersion` set; null keeps the version of the recorded status. */
  private hermesVersion: string | Error | null = null

  constructor(script: FakeScript = {}) {
    this.script = script
  }

  async status(): Promise<T.BackendStatus> {
    if (this.hermesVersion instanceof Error) {
      throw this.hermesVersion
    }
    const status = clone<T.BackendStatus>(statusFixture)
    return this.hermesVersion === null ? status : { ...status, version: this.hermesVersion }
  }

  /** Test hook: the Hermes version `status` reports from now on (as the server words it, `unknown` included), or an error it rejects with. */
  setHermesVersion(version: string | Error): void {
    this.hermesVersion = version
  }

  async login(): Promise<T.AuthIdentity | null> {
    return null
  }

  async me(): Promise<T.AuthIdentity | null> {
    return null
  }

  async logout(): Promise<void> {
    this.disconnectAll()
    this.cookiesCleared += 1
  }

  /** How many times the platform cookie jar would have been cleared. */
  cookiesCleared = 0

  async clearCookies(): Promise<void> {
    this.cookiesCleared += 1
  }

  async connect(profile: string): Promise<GatewayConnection> {
    return this.openConnection(profile)
  }

  private openConnection(profile: string): FakeConnection {
    let conn = this.connections.get(profile)
    if (!conn) {
      conn = new FakeConnection(profile, this.script)
      this.connections.set(profile, conn)
    }
    return conn
  }

  /** Test hook: the connection opened for `profile` (throws if not connected yet). */
  connectionFor(profile: string): FakeConnection {
    const conn = this.connections.get(profile)
    if (!conn) {
      throw new Error(`FakeGateway: profile "${profile}" has no open connection`)
    }
    return conn
  }

  disconnectAll(): void {
    for (const conn of this.connections.values()) {
      conn.close()
    }
    this.connections.clear()
  }

  /** The profile's `ui_meta` and revisions: what a write left, else the recorded roster's. */
  private metaOf(name: string): { uiMeta: T.UiMeta; revisions: Record<string, number> } {
    const stored = this.storedMeta.get(name)
    if (stored) {
      return stored
    }
    const recorded = (profilesListFixture.profiles as T.ProfileSummary[]).find(p => p.name === name)
    const meta = { uiMeta: clone<T.UiMeta>(recorded?.ui_meta ?? {}), revisions: clone<Record<string, number>>(recorded?.ui_meta_revisions ?? {}) }
    this.storedMeta.set(name, meta)
    return meta
  }

  /** Test hook: Hermes Desktop saving `hermes-bots` metadata, a merge without a revision check (last write wins). */
  desktopWrite(name: string, patch: T.HermesBotsMeta): void {
    const meta = this.metaOf(name)
    meta.uiMeta['hermes-bots'] = { ...meta.uiMeta['hermes-bots'], ...patch }
    meta.revisions['hermes-bots'] = (meta.revisions['hermes-bots'] ?? 0) + 1
  }

  /**
   * Like `_configure_ui_meta` at the pin (tui_gateway/methods_profiles.py:437-481):
   * each namespace is replaced whole (null deletes it) after a revision check
   * per namespace; one mismatch refuses the whole write.
   */
  private writeUiMeta(name: string, incoming: T.UiMeta, expected: Record<string, number> | undefined): T.ConfigureResult {
    const meta = this.metaOf(name)
    const keys = Object.keys(incoming)
    const conflicts: Record<string, { expected: number | undefined; actual: number }> = {}
    for (const key of expected ? keys : []) {
      const actual = meta.revisions[key] ?? 0
      if (expected?.[key] !== actual) {
        conflicts[key] = { expected: expected?.[key], actual }
      }
    }
    const revisionsOf = () => Object.fromEntries(keys.map(key => [key, meta.revisions[key] ?? 0]))
    if (Object.keys(conflicts).length > 0) {
      return { ok: false, applied: { ui_meta: false, ui_meta_conflicts: conflicts, ui_meta_revisions: revisionsOf() } }
    }
    for (const key of keys) {
      if (incoming[key] === null) {
        delete meta.uiMeta[key]
      } else {
        meta.uiMeta[key] = clone(incoming[key])
      }
      meta.revisions[key] = (meta.revisions[key] ?? 0) + 1
    }
    return { ok: true, applied: { ui_meta: true, ui_meta_revisions: revisionsOf() } }
  }

  private checkProfilesOnline(): void {
    if (this.profilesOffline) {
      throw new GatewayError('network', 'No connection to the gateway.')
    }
  }

  readonly profiles: ProfilesApi = {
    list: async () => {
      this.checkProfilesOnline()
      const listed = clone(profilesListFixture) as T.ProfilesListResult
      const recorded = new Set(listed.profiles.map(p => p.name))
      const created: T.ProfileSummary[] = [...this.profileNames].filter(name => !recorded.has(name)).map(name => ({ name, is_default: false }))
      const profiles = [...listed.profiles.filter(p => this.profileNames.has(p.name)), ...created].map(p => {
        const stored = this.storedMeta.get(p.name)
        return stored ? { ...p, ui_meta: clone<T.UiMeta>(stored.uiMeta), ui_meta_revisions: { ...stored.revisions } } : p
      })
      return { ...listed, profiles }
    },
    describe: async () => clone(profilesDescribeFixture) as T.ProfileDescribe,
    configure: async params => {
      this.checkProfilesOnline()
      if (!this.profileNames.has(params.name)) {
        // `_resolve_profile` at the pin: 4064 "profile not found".
        throw new GatewayError('rpc', `profile '${params.name}' not found`, { code: 4064 })
      }
      this.configureCalls.push(clone(params))
      this.beforeConfigure?.(params)
      return params.ui_meta ? this.writeUiMeta(params.name, params.ui_meta, params.ui_meta_expected_revisions) : { ok: true }
    },
    create: async params => {
      // Like `profiles.create` at the pin: an existing name is a FileExistsError, 4062.
      if (this.profileNames.has(params.name)) {
        throw new GatewayError('rpc', `Profile '${params.name}' already exists`, { code: 4062 })
      }
      this.profileNames.add(params.name)
      return { ok: true, name: params.name }
    },
    remove: async name => {
      this.profileNames.delete(name)
    },
    getAsset: async () => clone(assetAvatarFixture) as T.AssetResult,
    setAsset: async () => undefined,
    modelOptions: async () => clone(modelOptionsFixture) as T.ModelOptions,
    memory: async () => ({ memory: '', user: '', available: false })
  }

  /** Calls the script-driven RPCs recorded for assertions. */
  readonly calls = {
    activate: 0,
    title: [] as string[],
    history: 0,
    transcript: { count: 0, lastQuery: null as (T.TranscriptQuery & { sessionId: string }) | null }
  }

  readonly sessions: SessionsApi = {
    list: async () => ({ sessions: clone(this.script.sessions ?? []) as T.SessionRow[] }),
    create: async params => {
      const result = clone(sessionCreateFixture) as T.SessionCreateResult
      this.sessionOwner.set(result.session_id, params.profile)
      return result
    },
    activate: async (liveSessionId, opts) => {
      this.calls.activate += 1
      const conn = this.connectionForSession(liveSessionId)
      await conn.request('session.activate', { session_id: liveSessionId, omit_messages: opts?.omit_messages ?? true })
      if (this.script.activateSettling && this.calls.activate <= this.script.activateSettling) {
        throw new GatewayError('busy', 'The assistant is busy with another turn.', { code: 4009, data: 'session disconnect interrupt settling' })
      }
      const base = clone(sessionCreateFixture) as T.SessionCreateResult
      const open = conn.openRequestsFor(liveSessionId)
      const result: T.ActivateResult = {
        session_id: liveSessionId,
        session_key: base.stored_session_id,
        status: 'idle',
        running: false,
        messages: [],
        messages_omitted: true,
        message_count: 0,
        info: base.info,
        // Left out when empty, like `_live_session_payload` (server.py:3191-3196).
        ...(open.length > 0 ? { open_requests: open } : {}),
        ...(this.script.activate ?? {})
      }
      conn.redeliver(result.open_requests)
      return result
    },
    title: async (liveSessionId, title) => {
      this.calls.title.push(title)
      const conn = this.connectionForSession(liveSessionId)
      await conn.request('session.title', { session_id: liveSessionId, title })
      if (this.script.titleConflict) {
        throw new GatewayError('rpc', `Title '${title}' is already in use by session 20260101_000000_other`, { code: 4022 })
      }
      return { pending: false, title }
    },
    resume: async params => {
      const base = clone(sessionCreateFixture) as T.SessionCreateResult
      this.sessionOwner.set(base.session_id, params.profile ?? '')
      const conn = this.connections.get(params.profile ?? '')
      const open = conn?.openRequestsFor(base.session_id) ?? []
      const result: T.SessionResumeResult = {
        session_id: base.session_id,
        resumed: params.session_id,
        session_key: params.session_id,
        message_count: historyFixture.count,
        messages: clone(historyFixture.messages) as T.HistoryMessage[],
        running: false,
        status: 'idle',
        info: base.info,
        ...(open.length > 0 ? { open_requests: open } : {})
      }
      conn?.redeliver(result.open_requests)
      return result
    },
    history: async () => {
      this.calls.history += 1
      if (this.script.historyFailures && this.calls.history <= this.script.historyFailures) {
        throw new GatewayError('timeout', 'The gateway did not answer in time.')
      }
      const scripted = await this.script.history?.(this.calls.history)
      if (scripted !== undefined) {
        return { count: scripted.length, messages: clone(scripted) as T.HistoryMessage[] }
      }
      return clone(historyFixture) as T.HistoryResult
    },
    transcript: async (sessionId, opts) => {
      this.calls.transcript.count += 1
      this.calls.transcript.lastQuery = { sessionId, ...opts }
      const scripted = this.script.transcript?.({ sessionId, ...opts })
      if (scripted === 'reject') {
        throw new GatewayError('rpc', 'The gateway rejected the request.', { code: 4002 })
      }
      return normalizeTranscriptPage(scripted ?? defaultTranscriptPage(sessionId, opts))
    },
    submit: async (sessionId, text, opts) => {
      const conn = this.connectionForSession(sessionId)
      return conn.request<T.SubmitResult>('prompt.submit', { session_id: sessionId, text, ...(opts?.queued ? { queued: true } : {}) })
    },
    interrupt: async () => ({ status: 'interrupted' }),
    steer: async () => ({ status: 'queued' }),
    usage: async () => ({}),
    respondApproval: async p => {
      requireSent(this.connectionForSession(p.session_id).respond(p.request_id, { choice: p.choice }))
    },
    respondClarify: async p => {
      requireSent(this.connectionForSession(p.session_id).respond(p.request_id, { answers: p.answers }))
    },
    attachImageBytes: async () => ({}),
    attachFile: async () => ({}),
    close: async sessionId => {
      this.sessionOwner.delete(sessionId)
    },
    remove: async () => undefined
  }

  readonly routines: RoutinesApi = {
    list: async () => clone(cronJobsFixture) as T.CronJob[],
    create: async (_profile, body) => ({ id: 'job-fake', name: '', schedule: '', enabled: true, paused: false, ...body }) as T.CronJob,
    update: async (id, updates) => ({ id, name: '', schedule: '', enabled: true, paused: false, ...updates }) as T.CronJob,
    pause: async () => undefined,
    resume: async () => undefined,
    trigger: async () => undefined,
    remove: async () => undefined,
    runs: async () => []
  }

  readonly tools: ToolsApi = {
    toolsets: async () => clone(toolsetsFixture) as T.Toolset[],
    skills: async () => clone(skillsFixture) as T.SkillRow[],
    mcpServers: async () => clone(mcpServersFixture.servers ?? []) as T.McpServerRow[],
    testMcp: async () => ({ ok: true })
  }

  readonly files: FilesApi = {
    uploadImage: async (_profile, _dataUrl, filename) => ({ ok: true, path: `/uploads/${filename}`, name: filename, bytes: 0, mime_type: 'image/png' }),
    uploadFile: async path => ({ ok: true, path })
  }

  private connectionForSession(sessionId: string): FakeConnection {
    const profile = this.sessionOwner.get(sessionId)
    if (!profile) {
      throw new GatewayError('not_found', `FakeGateway: unknown session "${sessionId}"`)
    }
    return this.openConnection(profile)
  }
}
