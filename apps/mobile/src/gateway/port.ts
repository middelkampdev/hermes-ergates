/**
 * GatewayPort: the one seam between Ergates and Hermes (ADR-029).
 *
 * Every Hermes-owned read or write in the app goes through this contract.
 * `RealGateway` (src/gateway/real) speaks REST + JSON-RPC to `hermes serve`;
 * `FakeGateway` (test/fake-gateway) replays recorded fixtures. Neither side
 * of this file imports React Native or Expo.
 */

import type * as T from './types'

/**
 * The title of a profile's canonical chat. Hermes resolves a bot's Bot Chat by
 * this exact title, so it is part of the wire contract, not a feature detail.
 */
export const BOT_CHAT_TITLE = 'Bot Chat'

export type ConnectionState = 'connecting' | 'open' | 'closed' | 'error'

/** One live socket to `/api/ws?profile=<name>`; owns replay and heartbeat. */
export interface GatewayConnection {
  readonly profile: string
  readonly ready: T.GatewayReadyPayload
  readonly state: ConnectionState
  /**
   * The failure behind the most recent close or failed dial, or null while the
   * connection is healthy. `terminal` is true when reconnecting cannot help:
   * a 4401/4403/4404 close, or a credential that no longer authenticates.
   */
  readonly lastError: ConnectionFailure | null
  request<R>(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<R>
  onEvent(handler: (event: T.GatewayEventFrame) => void): () => void
  /**
   * The `approval` and `clarify` requests Hermes sends this socket, live and
   * again from `open_requests` after a reconnect (`replayed: true`). The
   * connection keeps each one open until `sessions.respondApproval` or
   * `sessions.respondClarify` answers it, or Hermes cancels it.
   */
  onRequest(handler: (request: T.ServerRequestFrame) => void): () => void
  onState(handler: (state: ConnectionState) => void): () => void
  replay(sessionId: string, lastSeen: number): Promise<T.ReplayResult>
  close(): void
}

/** A connection failure in a form the UI can act on. Never carries a URL or credential. */
export interface ConnectionFailure {
  kind: 'unauthorized' | 'forbidden' | 'network' | 'timeout' | 'rpc' | 'unknown' | (string & {})
  /** Already passed through `userMessage`; safe to render. */
  message: string
  /** Reconnecting cannot fix this; the owner must sign in again. */
  terminal: boolean
  code?: number | string
}

export interface ProfilesApi {
  list(): Promise<T.ProfilesListResult>
  describe(name: string): Promise<T.ProfileDescribe>
  configure(params: T.ConfigureParams): Promise<T.ConfigureResult>
  create(params: T.CreateProfileParams): Promise<unknown>
  remove(name: string): Promise<void>
  getAsset(name: string): Promise<T.AssetResult>
  /** `dataUrl === null` clears the avatar. */
  setAsset(name: string, dataUrl: string | null): Promise<void>
  modelOptions(profile: string): Promise<T.ModelOptions>
  memory(name: string): Promise<T.MemoryFiles>
}

export interface SessionsApi {
  list(params: { title?: string; limit?: number; include_hidden?: boolean; profile?: string }): Promise<{ sessions: T.SessionRow[] }>
  /**
   * `follow_profile_config` pins the session's runtime to the profile's CURRENT
   * config instead of the model/provider stored on the row (PR #97008); the
   * canonical Bot Chat always sends it.
   */
  create(params: { title: string; profile: string; hidden?: boolean; follow_profile_config?: boolean }): Promise<T.SessionCreateResult>
  resume(params: { session_id: string; profile?: string }): Promise<T.SessionResumeResult>
  /**
   * Rebinds the live session's event transport to the current socket and reports
   * the inflight turn, the run status and the server requests still open
   * (`open_requests`). The connection delivers each open request again, with
   * `replayed: true`, before this resolves. Must be called after every reconnect:
   * a disconnect parks the session's transport on a drop sink
   * (session_lifecycle.py:1039), and only resume/activate/prompt.submit rebind it.
   */
  activate(liveSessionId: string, opts?: { omit_messages?: boolean }): Promise<T.ActivateResult>
  /**
   * Writes the title eagerly. `session.create` is lazy — no DB row exists until
   * the first turn ends — so the canonical chat writes its title immediately or
   * the (profile, title) registry has no entry and a second open forks the chat.
   */
  title(liveSessionId: string, title: string): Promise<T.TitleResult>
  history(sessionId: string): Promise<T.HistoryResult>
  /** Read-only page of the durable transcript. `order` is always sent explicitly. */
  transcript(sessionId: string, opts: T.TranscriptQuery): Promise<T.TranscriptPage>
  /** Sent exactly once per attempt. Never retried by the adapter. */
  submit(sessionId: string, text: string, opts?: { queued?: boolean }): Promise<T.SubmitResult>
  /** `{status:'not_interrupted'}` when there was no live turn to stop. */
  interrupt(sessionId: string): Promise<T.InterruptResult>
  /** `{status:'queued'}` when accepted, `{status:'rejected'}` when the agent refused. */
  steer(sessionId: string, text: string): Promise<T.SteerResult>
  usage(sessionId: string): Promise<T.UsagePayload>
  /**
   * Answer the server request `request_id` (`srq-<12 hex>`) with one response
   * frame on the session's socket. Rejects with `network` when the socket is
   * down (the request stays open) and with `not_found` when Hermes no longer
   * waits for it.
   */
  respondApproval(p: { session_id: string; request_id: string; choice: T.ApprovalChoice }): Promise<void>
  /**
   * Answers every question of a `clarify` request at once; `null` skips a question. `answers: null` skips
   * them all: the frame carries no `answers`, so Hermes ends the request as cancelled and keeps the answers
   * another client locked. Rejects like `respondApproval`.
   */
  respondClarify(p: { session_id: string; request_id: string; answers: Record<string, string | null> | null }): Promise<void>
  /** Answers a password prompt (`PromptMethod`) with `{value}`; `''` declines it. Rejects like `respondApproval`. */
  respondValue(p: { session_id: string; request_id: string; value: string }): Promise<void>
  attachImageBytes(p: { session_id: string; content_base64: string; filename?: string; ext?: string }): Promise<unknown>
  /** Either a server `path` or a `data_url` + `name` (the gateway stores it and returns `ref_text`). */
  attachFile(p: { session_id: string; path?: string; data_url?: string; name?: string }): Promise<{ attached?: boolean; name?: string; path?: string; ref_text?: string; [k: string]: unknown }>
  close(sessionId: string): Promise<void>
  remove(storedSessionId: string): Promise<void>
}

export interface RoutinesApi {
  list(profile: string): Promise<T.CronJob[]>
  create(profile: string, body: Record<string, unknown>): Promise<T.CronJob>
  update(id: string, updates: Record<string, unknown>, profile?: string): Promise<T.CronJob>
  pause(id: string, profile?: string): Promise<void>
  resume(id: string, profile?: string): Promise<void>
  trigger(id: string, profile?: string): Promise<void>
  remove(id: string, profile?: string): Promise<void>
  runs(id: string, profile?: string): Promise<T.CronRun[]>
}

export interface ToolsApi {
  toolsets(profile: string): Promise<T.Toolset[]>
  skills(profile: string): Promise<T.SkillRow[]>
  mcpServers(profile: string): Promise<T.McpServerRow[]>
  testMcp(name: string, profile: string): Promise<{ ok: boolean; [k: string]: unknown }>
}

export interface FilesApi {
  uploadImage(profile: string, dataUrl: string, filename: string): Promise<T.ImageUploadResult>
  uploadFile(path: string, dataUrl: string): Promise<T.FileUploadResult>
}

/**
 * The Ergates integration routes under `/api/plugins/ergates`, behind the
 * connection's own Hermes auth. An Ergates error rejects with `GatewayError`
 * whose `code` is the Ergates error code (`invalid`, `not_found`,
 * `name_taken`, ...). `createReminder` resolves for 200, 201, 202 and 409
 * instead: each of those answers carries the receipt.
 */
export interface ErgatesApi {
  /**
   * Resolves for a 200 (`answered`) and for the two 404s the path can answer
   * (`absent`, `not_loaded`). Any other answer rejects, with
   * `code: 'store_unavailable'` when the plugin cannot open its store.
   */
  health(): Promise<T.PluginProbe>
  /** `POST /setup`: installs the templates and enables the plugin in every profile. */
  setup(): Promise<T.SetupState>
  createReminder(req: T.ReminderRequest): Promise<T.ReminderOutcome>
  getProposal(proposalId: string): Promise<T.ProposalReceipt>
  acceptProposal(proposalId: string, proposal: T.AgentProposal): Promise<T.ProposalReceipt>
  rejectProposal(proposalId: string): Promise<T.ProposalReceipt>
  recordProposalStep(proposalId: string, step: T.ProvisionStep, status: T.StepStatus): Promise<T.ProposalReceipt>
  enablePlugin(profile: string): Promise<{ profile: string; enabled: boolean }>
  /** `scope` is a profile name, or `*` for every agent. */
  attentionPrefs(scope: string): Promise<T.AttentionPrefs>
  setAttentionPrefs(prefs: T.AttentionPrefs): Promise<T.AttentionPrefs>
}

/**
 * How long an install may run before the app gives up on it. An install
 * answers when it ends and Hermes shows no progress. Each of its three git
 * phases (clone, fetch, checkout) may take up to `plugins.clone_timeout_seconds`,
 * 300 s by default.
 */
export const PLUGIN_INSTALL_TIMEOUT_MS = 900_000

/**
 * Hermes's own plugin routes, behind the connection's auth. An install can run
 * for minutes (a git download in up to three phases) and answers only when it
 * ends. A refusal rejects with `GatewayError`; for `install` its `code` is a
 * `PluginInstallCode` when Hermes's text is one the app knows. `enable` maps no
 * code: any refusal is a plain error with Hermes's text as the message, and so
 * does `disable`. `disable` only writes the config: a running server keeps the
 * plugin's code until it restarts.
 */
export interface PluginsApi {
  hub(): Promise<T.HermesPluginRow[]>
  install(req: T.PluginInstallRequest): Promise<T.PluginInstallResult>
  enable(name: string): Promise<void>
  disable(name: string): Promise<void>
}

export interface GatewayPort {
  status(): Promise<T.BackendStatus>
  login(creds: T.Credentials): Promise<T.AuthIdentity | null>
  me(): Promise<T.AuthIdentity | null>
  logout(): Promise<void>
  /**
   * Removes what this phone stores for this connection id (sign-in mode, token, cookie), with no request.
   * For a gateway whose connection is never saved: the throwaway one behind Check, and one the app refused.
   */
  discardStoredSecrets(): Promise<void>
  /**
   * Clears leftover platform cookie jars for this gateway's origin. Requests no
   * longer use the native jar, but jars that older app versions filled still
   * hold the sign-in, so sign-out and connection removal clear them even when
   * `POST /auth/logout` failed (docs/04 section 6, ADR-028).
   */
  clearCookies(): Promise<void>
  /** Opens (or reuses) the socket for one profile. */
  connect(profile: string): Promise<GatewayConnection>
  /** Closes every socket owned by this port. */
  disconnectAll(): void
  profiles: ProfilesApi
  sessions: SessionsApi
  routines: RoutinesApi
  tools: ToolsApi
  files: FilesApi
  ergates: ErgatesApi
  plugins: PluginsApi
}

/**
 * What the registry hands to screens and features: the port, plus `restore()`,
 * which reloads the saved credential before the first call after a cold start
 * and says which one it found. `'none'` means this phone holds no sign-in for
 * the connection (on a rooted phone, after every restart), so Home sends the
 * owner to sign in again.
 * Nothing outside `src/gateway` sees the adapter class (ADR-029 rule 1).
 */
export type ConnectedGateway = GatewayPort & { restore(): Promise<'none' | 'token' | 'password'> }
