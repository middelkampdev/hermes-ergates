/**
 * Wire types for the Hermes gateway. Pinned backend: commit 818c13be
 * (v0.21.6). The server request types (approval, clarify, `request.cancel`,
 * `open_requests`) follow tui_gateway/contracts/server_requests.py at that
 * commit; the other types were verified at 0.21.2. See
 * docs/06-hermes-api-contract.md for the backend wire shapes.
 *
 * This module imports nothing from React Native or Expo (ADR-029 rule 1).
 */

// ── discovery and auth ───────────────────────────────────────────────────

export interface BackendStatus {
  version: string
  auth_required: boolean
  auth_providers: string[]
  auth_flows: string[]
  install_id?: string
  release_date?: string
  [k: string]: unknown
}

export type AuthMode = 'token' | 'password'

export type Credentials =
  | { mode: 'token'; token: string }
  | { mode: 'password'; provider: string; username: string; password: string }

export interface AuthIdentity {
  user_id: string
  email?: string
  display_name?: string
  org_id?: string
  provider: string
  expires_at?: number
}

// ── profiles ─────────────────────────────────────────────────────────────

/** Desktop Bot Mode namespace inside `ui_meta`. Unknown keys must round-trip. */
export interface HermesBotsMeta {
  title?: string
  shape?: string
  color?: string
  imageKind?: string
  custom?: boolean
  hidden?: boolean
  pinned?: boolean
  /** Desktop writes null when an agent leaves its section. */
  sectionId?: string | null
  /** Written next to `sectionId` by newer Hermes Desktop and by this app. */
  sectionName?: string | null
  [k: string]: unknown
}

/** Ergates namespace inside `ui_meta` (docs/05, docs/10). */
export interface ErgatesMeta {
  role?: string
  [k: string]: unknown
}

export interface UiMeta {
  'hermes-bots'?: HermesBotsMeta
  ergates?: ErgatesMeta
  [ns: string]: unknown
}

export interface CanonicalSession {
  id: string
  resolved_id?: string
  root_title?: string
  title: string
  preview?: string
  started_at?: number
  last_active?: number
  message_count?: number
}

export interface ProfileSummary {
  name: string
  path?: string
  is_default: boolean
  model?: string
  provider?: string
  description?: string
  display_name?: string
  skill_count?: number
  last_session?: unknown
  worker_session?: unknown
  canonical_session?: CanonicalSession | null
  ui_meta?: UiMeta
  ui_meta_revisions?: Record<string, number>
  has_avatar?: boolean
}

export interface ProfilesListResult {
  profiles: ProfileSummary[]
  bot_mode_protocol?: boolean
}

export interface DescribeSkill {
  name: string
  enabled: boolean
}

export interface DescribeToolset {
  name: string
  label: string
  description: string
  tool_count: number
  enabled: boolean
}

export interface DescribeMcpServer {
  name: string
  enabled?: boolean
  [k: string]: unknown
}

export interface ProfileDescribe {
  name: string
  description: string
  soul: string
  model: { provider: string; default: string }
  skills: DescribeSkill[]
  toolsets: DescribeToolset[]
  toolsets_pinned: boolean
  mcp_servers: DescribeMcpServer[]
  [k: string]: unknown
}

export interface ConfigureParams {
  name: string
  ui_meta?: UiMeta
  ui_meta_expected_revisions?: Record<string, number>
  soul?: string
  description?: string
  model?: string
  provider?: string
  disabled_skills?: string[]
  enabled_toolsets?: string[]
  enabled_mcp_servers?: string[]
  confirm_expensive_model?: boolean
}

export interface ConfigureResult {
  ok: boolean
  applied?: Record<string, unknown>
  confirm_required?: boolean
  error?: string
  conflicts?: unknown
  ui_meta_revisions?: Record<string, number>
  [k: string]: unknown
}

export interface CreateProfileParams {
  name: string
  description?: string
  soul?: string
  model?: string
  provider?: string
  /** Ergates always provisions fresh profiles without launch credentials. */
  mirror_credentials: false
  share_auth?: boolean
  no_alias?: boolean
}

export interface AssetResult {
  found: boolean
  /** Data URL (`data:image/png;base64,...`) when found. */
  data?: string
  mime?: string
  size?: number
}

export interface ModelCapability {
  fast?: boolean
  reasoning?: boolean
}

export interface ModelProvider {
  slug: string
  name: string
  is_current: boolean
  is_user_defined?: boolean
  authenticated: boolean
  models: string[]
  total_models?: number
  source?: string
  auth_type?: string
  warning?: string
  capabilities?: Record<string, ModelCapability>
  featured_models?: string[]
}

export interface ModelOptions {
  providers: ModelProvider[]
  [k: string]: unknown
}

// ── sessions ─────────────────────────────────────────────────────────────

export interface SessionRow {
  id: string
  resolved_id?: string
  title: string
  preview: string
  started_at: number
  message_count: number
  source: string
}

export interface SessionInfoPayload {
  model?: string
  provider?: string
  reasoning_effort?: string
  service_tier?: string
  fast?: boolean
  yolo?: boolean
  approval_mode?: string
  tools?: Record<string, string[]>
  skills?: Record<string, string[]>
  cwd?: string
  branch?: string
  lazy?: boolean
  profile_name?: string
  [k: string]: unknown
}

export interface HistoryMessage {
  role: 'user' | 'assistant' | 'tool'
  text?: string
  timestamp?: number
  row_id?: number
  display_kind?: string
  display_metadata?: unknown
  /** tool rows */
  name?: string
  context?: string
  args?: Record<string, unknown>
  /** assistant detail sidecars */
  reasoning?: string
  reasoning_content?: string
  [k: string]: unknown
}

export interface HistoryResult {
  count: number
  messages: HistoryMessage[]
}

// ── transcript (REST) ────────────────────────────────────────────────────

export interface TranscriptToolCall {
  id: string
  name: string
  args: Record<string, unknown>
}

export interface TranscriptRow {
  id: number
  role: 'user' | 'assistant' | 'tool' | 'system'
  /** display_content ?? content, as text. */
  text: string
  content: string
  toolCalls?: TranscriptToolCall[]
  toolCallId?: string
  toolName?: string
  /** Tool-row content JSON-decoded when it parses, else the raw string. */
  result?: unknown
  /** Unix seconds. */
  at?: number
  displayKind?: string
  displayMetadata?: unknown
}

export interface TranscriptPage {
  sessionId: string
  rows: TranscriptRow[]
  page: { limit: number; offset: number; returned: number }
}

/** The wire response of GET /api/sessions/{id}/messages (hermes_cli/web_routers/sessions.py:553-565). */
export interface TranscriptRawPage {
  session_id: string
  profile?: string
  messages: unknown[]
  pagination: { limit: number; offset: number; order: string; returned: number }
}

export interface TranscriptQuery {
  profile: string
  limit: number
  offset?: number
  order: 'latest' | 'oldest'
  includeCompacted?: boolean
}

export interface SessionCreateResult {
  session_id: string
  stored_session_id: string
  message_count: number
  messages: HistoryMessage[]
  info: SessionInfoPayload
}

export interface SessionResumeResult {
  session_id: string
  resumed: string
  session_key: string
  message_count: number
  messages: HistoryMessage[]
  messages_omitted?: boolean
  hydrating?: boolean
  info: SessionInfoPayload
  inflight?: InflightSnapshot | null
  running: boolean
  status: string
  started_at?: number
  open_requests?: OpenServerRequest[]
  /** Present only when a crash-interrupted turn was scheduled to continue (session_auto_continue.py:57). */
  auto_continue?: unknown
  [k: string]: unknown
}

/**
 * The live turn as the server projects it for a reattaching client
 * (`_inflight_snapshot`, tui_gateway/session_auto_continue.py:339). `corrections`
 * are mid-turn redirects/steers; `error` marks a retained failed turn.
 */
export interface InflightSnapshot {
  user: string
  assistant: string
  streaming: boolean
  corrections?: string[]
  correction_offsets?: number[]
  error?: string
  [k: string]: unknown
}

/** The accepted next-turn prompt (`_queued_prompt_snapshot`). */
export interface QueuedPromptSnapshot {
  user: string
  [k: string]: unknown
}

/**
 * `session.activate {session_id, omit_messages}` — `_live_session_payload`
 * (tui_gateway/server.py:3157-3196). This is the RPC that rebinds the session's
 * transport to the current socket. `open_requests` lists the server requests
 * still waiting on the session, and is left out when there are none.
 */
export interface ActivateResult {
  session_id: string
  session_key: string
  status: string
  running: boolean
  turn_started_at?: number | null
  started_at?: number
  message_count: number
  messages: HistoryMessage[]
  messages_omitted?: boolean
  info: SessionInfoPayload
  inflight?: InflightSnapshot | null
  queued?: QueuedPromptSnapshot | null
  open_requests?: OpenServerRequest[]
  [k: string]: unknown
}

/** `session.title {session_id, title}` — `pending: true` means the row is not written yet. */
export interface TitleResult {
  pending?: boolean
  title?: string
  session_key?: string
  [k: string]: unknown
}

/** `session.interrupt` / `session.steer`: a refusal is a status, not an error. */
export interface InterruptResult {
  status?: 'interrupted' | 'not_interrupted' | (string & {})
  [k: string]: unknown
}

export interface SteerResult {
  status?: 'steered' | 'rejected' | 'queued' | (string & {})
  [k: string]: unknown
}

export interface GatewayEventFrame {
  type: string
  session_id?: string
  seq?: number
  payload?: unknown
}

export interface ReplayResult {
  events: GatewayEventFrame[]
  latest_seq: number
  truncated: boolean
  count: number
  epoch: string
  open_requests?: OpenServerRequest[]
}

export interface SubmitResult {
  status: 'streaming' | 'queued' | 'steered' | 'redirected' | (string & {})
  [k: string]: unknown
}

export interface UsagePayload {
  model?: string
  input?: number
  output?: number
  reasoning?: number
  total?: number
  calls?: number
  context_used?: number
  context_max?: number
  context_percent?: number
  compressions?: number
  [k: string]: unknown
}

// ── event payloads ───────────────────────────────────────────────────────

export interface GatewayReadyPayload {
  skin?: unknown
  change_events?: boolean
  heartbeat?: boolean
  replay_epoch?: string
  [k: string]: unknown
}

export interface TextPayload {
  text?: string
  [k: string]: unknown
}

/** `{layer, code, retryable, provider?, model?}` (agent/error_surface.py:76). */
export interface ErrorSurface {
  layer?: string
  code?: string
  retryable?: boolean
  provider?: string
  model?: string
  [k: string]: unknown
}

/**
 * `message.complete` (tui_gateway/prompt_turn.py:629-683). On `status === 'error'`
 * the payload carries `error` + `recoverable` + `error_surface`; `failure_reason`
 * appears only alongside the billing-wall `billing` descriptor.
 */
export interface MessageCompletePayload {
  text?: string
  usage?: UsagePayload
  status?: string
  reasoning?: string
  warning?: string
  error?: string
  recoverable?: boolean
  error_surface?: ErrorSurface
  failure_reason?: string
  billing?: unknown
  [k: string]: unknown
}

/**
 * `message.interim` (wire contract section A.6): assistant commentary emitted
 * alongside tool calls. `already_streamed: true` means the same text already
 * arrived as `message.delta`s and must not be rendered twice.
 */
export interface MessageInterimPayload {
  text?: string
  already_streamed?: boolean
  [k: string]: unknown
}

export interface StatusUpdatePayload {
  text?: string
  status?: string
  message?: string
  /** `process` marks a background-process notification: receipt or notice grammar, never working-line copy (spec 5.8/5.9). */
  kind?: string
  [k: string]: unknown
}

export interface ToolStartPayload {
  tool_id: string
  name: string
  context?: string
  args?: Record<string, unknown>
}

export interface ToolCompletePayload {
  tool_id: string
  name: string
  args?: Record<string, unknown>
  duration_s?: number
  result?: unknown
  error?: string
}

/** A clarify question as the card shows it: `choices` and `multi_select` filled in. */
export interface ClarifyQuestion {
  qid: string
  question: string
  choices: string[]
  multi_select: boolean
}

export type ApprovalChoice = 'once' | 'session' | 'always' | 'deny'

// ── server-to-client requests ────────────────────────────────────────────

/**
 * A server request still waiting for an answer, as `open_requests` lists it
 * (tui_gateway/server_requests.py:74-80). `id` is `srq-<12 hex>`
 * (server_requests.py:55); Hermes waits for a response frame with that id.
 */
export interface OpenServerRequest {
  id: string
  method: string
  params: { session_id?: string; [k: string]: unknown }
}

/** One server request as a connection hands it over. `replayed` is true when it came from `open_requests` after a reconnect. */
export interface ServerRequestFrame extends OpenServerRequest {
  replayed: boolean
}

/** `approval` params (tui_gateway/contracts/server_requests.py:107-121). The answer is `{choice}`. */
export interface ApprovalRequestParams {
  session_id: string
  request_id: string
  command?: string
  description?: string
  choices?: ApprovalChoice[]
  allow_permanent?: boolean | null
  allow_session?: boolean | null
  smart_denied?: boolean | null
  tool_name?: string | null
  [k: string]: unknown
}

/**
 * `clarify` params (tui_gateway/contracts/server_requests.py:34-45). The answer
 * is `{answers}` for the whole set, `null` for a skipped question.
 */
export interface ClarifyRequestParams {
  session_id: string
  questions: { qid: string; question: string; choices?: string[] | null; multi_select?: boolean }[]
  answers?: Record<string, string | null> | null
}

/** `request.cancel`: Hermes stopped waiting for request `id` (tui_gateway/contracts/server_requests.py:260-267). */
export interface RequestCancelPayload {
  id: string
  method: string
  reason: string
}

/** `{task_id, text}` (tui_gateway/methods_prompt.py:920-941, :994). No `agent`, no `source`. */
export interface BackgroundCompletePayload {
  task_id?: string
  text?: string
  [k: string]: unknown
}

export interface ErrorPayload {
  message?: string
  code?: number | string
  [k: string]: unknown
}

// ── REST surfaces ────────────────────────────────────────────────────────

export interface CronJob {
  id: string
  name: string
  schedule: string
  prompt?: string
  enabled?: boolean
  paused?: boolean
  next_run?: string | number | null
  last_run?: string | number | null
  timezone?: string
  profile?: string
  [k: string]: unknown
}

export interface CronRun {
  id?: string
  started_at?: string | number
  finished_at?: string | number
  ended_at?: string | number | null
  last_active?: string | number
  status?: string
  output?: string
  error?: string
  /** Added by the cron runs REST route: still running within the last five minutes. */
  is_active?: boolean
  archived?: boolean
  profile?: string
  [k: string]: unknown
}

export interface Toolset {
  name: string
  label: string
  description: string
  enabled: boolean
  available?: boolean
  configured?: boolean
  platform?: string
  tools: string[]
}

export interface SkillRow {
  name: string
  description: string
  category?: string
  enabled: boolean
  usage?: number
  provenance?: string
}

export interface McpServerRow {
  name: string
  enabled?: boolean
  transport?: string
  [k: string]: unknown
}

export interface ImageUploadResult {
  ok: boolean
  path: string
  name: string
  bytes: number
  mime_type: string
}

export interface FileUploadResult {
  ok: boolean
  path: string
  [k: string]: unknown
}

export interface MemoryFiles {
  memory: string
  user: string
  available: boolean
}

// ── Ergates integration routes (/api/plugins/ergates) ──

/**
 * The body of `GET /health` (`Operations.health` in the plugin). The fields
 * after `schema_version` are optional because an older plugin leaves them out.
 */
export interface ErgatesHealth {
  ok: boolean
  plugin_version: string
  api_level?: number
  min_api_level?: number
  schema_version: number
  store?: { plugin_schema_version: number; min_schema_version: number; writable: boolean }
  /** How the plugin got onto the server; `commit` is known for a `git install` only. */
  install?: { kind: 'deployment' | 'git install' | 'manual copy'; commit: string | null; catalog_name: string | null }
  setup?: SetupState
  push?: { configured: boolean; token_set: boolean; legacy_config_token: boolean }
  /** `last_run_at` is epoch seconds (the plugin's `time.time()`), null before the first pass. */
  sweep?: { interval_seconds: number; last_run_at: number | null; last_error: string | null }
}

/** The state `POST /setup` makes, and the report it answers (`setup_report` in the plugin). */
export interface SetupState {
  finished: boolean
  templates: 'installed' | 'differ' | 'invalid' | 'missing' | 'failed'
  profiles: { name: string; enabled: boolean; error?: string }[]
}

/**
 * What asking a server for the plugin's health found: the plugin answered;
 * Hermes does not serve it (not installed, not enabled or disabled); or it is
 * enabled but its routes are not mounted (its import failed, or Hermes cannot
 * mount a plugin after it started).
 */
export type PluginProbe = { state: 'answered'; health: ErgatesHealth } | { state: 'absent' } | { state: 'not_loaded' }

export interface ReminderRequest {
  profile: string
  schedule: string
  /** IANA zone name, for example `Europe/Amsterdam`. Advisory: Hermes cron runs in Hermes's configured time zone, not the phone's. */
  timezone: string
  prompt: string
  /** One per create attempt, unique across every profile of the install: `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`. */
  request_id: string
  /** At most 64 printable characters. It becomes part of the cron job's name, so it is never prompt text. */
  label?: string
}

export interface ReminderReceipt {
  id: string
  request_id: string | null
  profile: string
  state: 'creating' | 'created' | 'uncertain'
  job_id: string | null
  timezone_advisory: string
  payload_hash: string
}

export interface ReminderOutcome {
  status: 'created' | 'existing' | 'conflict' | 'uncertain'
  receipt: ReminderReceipt
}

/** Provisioning steps in the order the server accepts them. */
export const PROVISION_STEPS = ['profile_created', 'plugin_enabled', 'configured', 'bot_chat', 'briefing'] as const
export type ProvisionStep = (typeof PROVISION_STEPS)[number]
export type StepStatus = 'done' | 'uncertain' | 'failed'

/** Exactly the JSON the `ergates_propose_agent` tool returns. */
export interface AgentProposal {
  kind: 'ergates.agent-proposal.v1'
  proposal_id: string
  /** ISO-8601 UTC. */
  expires_at: string
  source_session_id: string | null
  agent: {
    name: string
    title: string
    role: string
    description: string
    template_id: string
    provider: string
    model: string
  }
  briefing: string
}

export interface ProposalTemplate {
  template_id: string
  soul: string
  enabled_toolsets: string[]
  enabled_mcp_servers: string[]
}

export interface ProposalReceipt {
  proposal_id: string
  state: 'proposed' | 'accepted' | 'complete' | 'rejected' | 'expired'
  reserved_profile_name: string
  expires_at: string
  completed_steps: ProvisionStep[]
  step_status: Partial<Record<ProvisionStep, StepStatus>>
  next_step: ProvisionStep | null
  /** Only the accept answer carries it; GET, reject and steps answer null. */
  template: ProposalTemplate | null
}

export interface AttentionPrefs {
  /** A profile name, or `*` for the default of every profile. */
  profile: string
  muted: boolean
  /** `HH:MM`; both set or both null. */
  quiet_start: string | null
  quiet_end: string | null
}
