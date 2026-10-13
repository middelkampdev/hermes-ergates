/**
 * FakeErgates: the Ergates integration routes in memory.
 *
 * It answers with the outcomes and error codes of the integration's
 * `ergates/operations.py`, built through the same `mapErgatesError`
 * the real adapter uses, so an app test meets what the real server answers.
 * Test hooks: `record` (what the propose tool does), `nextCreateUncertain`,
 * `fail`, `failInternal`, `setHealth` (what the health probe finds),
 * `loadedCommit` (the commit the running code came from), `setSetupResult`;
 * logs: `calls`, `setupCalls`, `jobs`, `enabledPlugins`.
 * Until `setHealth` is called, the health of a current plugin reports the
 * install record's commit from `installedCommit` and the loaded commit apart,
 * so a reinstall moves the first and only a restart (a test setting
 * `loadedCommit`) moves the second. A first install is the exception: Hermes
 * mounts a new plugin at once, so `FakeGateway` moves the second with it.
 *
 * No React Native or Expo imports (ADR-029 rule 1).
 */

import { mapErgatesError, type GatewayError } from '@/gateway/errors'
import type { ErgatesApi } from '@/gateway/port'
import {
  PROVISION_STEPS,
  type AgentProposal,
  type AttentionPrefs,
  type ErgatesHealth,
  type PluginProbe,
  type ProposalReceipt,
  type ProposalTemplate,
  type ProvisionStep,
  type ReminderOutcome,
  type ReminderReceipt,
  type ReminderRequest,
  type SetupState,
  type StepStatus
} from '@/gateway/types'

export type ErgatesOp = keyof ErgatesApi

/** The one proposal template the fake server holds. */
export const PROPOSAL_TEMPLATE: ProposalTemplate = {
  template_id: 'bookkeeper',
  soul: 'You keep the books.',
  enabled_toolsets: ['file', 'ergates'],
  enabled_mcp_servers: []
}

/** A finished setup: the templates are in place and the plugin is enabled in the one profile. */
export const FAKE_SETUP: SetupState = { finished: true, templates: 'installed', profiles: [{ name: 'default', enabled: true }] }

/** The commit a current plugin was installed from, and is running. */
export const FAKE_PLUGIN_COMMIT = 'a'.repeat(40)

/** The health body of a current plugin that is installed, set up and idle (`Operations.health`). */
export const FAKE_PLUGIN_HEALTH: ErgatesHealth = {
  ok: true,
  plugin_version: '0.2.0',
  api_level: 1,
  min_api_level: 1,
  schema_version: 1,
  store: { plugin_schema_version: 1, min_schema_version: 1, writable: true },
  install: { kind: 'git install', commit: FAKE_PLUGIN_COMMIT, loaded_commit: FAKE_PLUGIN_COMMIT, catalog_name: null },
  setup: FAKE_SETUP,
  push: { configured: false, token_set: false, legacy_config_token: false },
  sweep: { interval_seconds: 120, last_run_at: null, last_error: null }
}

/** What `setHealth` takes: a probe, an error to reject with, or a function that returns either at every call. */
export type HealthScript = PluginProbe | Error | (() => PluginProbe | Error)

const PROFILE_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/
const REQUEST_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const CLOCK_RE = /^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/
const LABEL_MAX_LEN = 64
const STATUSES: StepStatus[] = ['done', 'uncertain', 'failed']
const HTTP_STATUS: Record<string, number> = {
  invalid: 400,
  not_found: 404,
  unknown_profile: 404,
  hash_mismatch: 409,
  not_acceptable: 409,
  name_taken: 409,
  out_of_order: 409,
  not_ready: 409,
  expired: 410,
  unknown_template: 422
}

function c3(code: string, message: string): GatewayError {
  return mapErgatesError(HTTP_STATUS[code] ?? 400, { error: { code, message } })
}

/** The server's own answer on an unexpected failure (`operations.internal_error`): 500, fixed message. */
function internal(): GatewayError {
  return mapErgatesError(500, { error: { code: 'internal', message: 'The request could not be completed.' } })
}

/** Key order never matters, as in the integration's `payload_hash`. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(',')}]`
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record)
      .sort()
      .map(key => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

/** 8 hex characters (FNV-1a), standing in for the server's sha256 tag. */
function tag(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

function isZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone })
    return true
  } catch {
    return false
  }
}

interface StoredReminder {
  payloadKey: string
  jobName: string
  receipt: ReminderReceipt
}

interface StoredProposal {
  proposal: AgentProposal
  hash: string
  state: 'proposed' | 'accepted' | 'complete' | 'rejected'
  steps: Partial<Record<ProvisionStep, StepStatus>>
}

interface Fault {
  op: ErgatesOp
  error: Error | 'hang'
  when: 'before' | 'after'
}

export interface FakeErgatesOptions {
  /** Whether a Hermes profile exists: the gateway's profile list. */
  hasProfile: (name: string) => boolean
  templates?: Record<string, ProposalTemplate>
  /** Milliseconds, for proposal expiry. */
  now?: () => number
  /** The commit of the plugin's install record, read at every default health call. */
  installedCommit?: () => string | null
}

export class FakeErgates implements ErgatesApi {
  /** Every call, in order. */
  readonly calls: { op: ErgatesOp; args: unknown[] }[] = []
  /** The cron jobs the reminder route made. */
  readonly jobs: { id: string; profile: string; name: string; schedule: string }[] = []
  readonly enabledPlugins = new Set<string>()
  /** The commit the running plugin code was loaded from. It moves when a test moves it, as a restart does, and when `FakeGateway` installs a plugin where there was none. */
  loadedCommit: string | null = FAKE_PLUGIN_COMMIT

  private readonly hasProfile: (name: string) => boolean
  private readonly templates: Record<string, ProposalTemplate>
  private readonly now: () => number
  private readonly installedCommit: () => string | null
  private readonly reminders = new Map<string, StoredReminder>()
  private readonly proposals = new Map<string, StoredProposal>()
  private readonly prefs = new Map<string, Omit<AttentionPrefs, 'profile'>>()
  private readonly faults: Fault[] = []
  private readonly uncertain: { jobCreated: boolean }[] = []
  private healthScript: HealthScript | undefined
  private setupResult: SetupState = FAKE_SETUP

  constructor(options: FakeErgatesOptions) {
    this.hasProfile = options.hasProfile
    this.templates = options.templates ?? { [PROPOSAL_TEMPLATE.template_id]: PROPOSAL_TEMPLATE }
    this.now = options.now ?? Date.now
    this.installedCommit = options.installedCommit ?? (() => FAKE_PLUGIN_COMMIT)
  }

  /** What `ergates_propose_agent` does: record the proposal as `proposed`. */
  record(proposal: AgentProposal): void {
    this.proposals.set(proposal.proposal_id, { proposal: structuredClone(proposal), hash: canonical(proposal), state: 'proposed', steps: {} })
  }

  /** The next new reminder answers 202: Hermes cron raised, and the job may exist anyway. */
  nextCreateUncertain(opts: { jobCreated: boolean }): void {
    this.uncertain.push(opts)
  }

  /**
   * The next call of `op` fails with `error` (or never settles, `'hang'`):
   * `before` it takes effect, or `after` it did (the answer was lost).
   */
  fail(op: ErgatesOp, error: Error | 'hang', when: 'before' | 'after' = 'before'): void {
    this.faults.push({ op, error, when })
  }

  /**
   * The next call of `op` fails as the server does on an unexpected error:
   * 500 `{"error": {"code": "internal", "message": "The request could not
   * be completed."}}` (`internal_error` in `ergates/operations.py`).
   */
  failInternal(op: ErgatesOp, when: 'before' | 'after' = 'before'): void {
    this.fail(op, internal(), when)
  }

  /** What every `health` call finds from now on: a probe, an error to reject with, or a function of either. */
  setHealth(script: HealthScript): void {
    this.healthScript = script
  }

  /** The report every `setup` call answers from now on. */
  setSetupResult(state: SetupState): void {
    this.setupResult = state
  }

  /** How many `POST /setup` calls there were, failed ones included. */
  get setupCalls(): number {
    return this.calls.filter(call => call.op === 'setup').length
  }

  health(): Promise<PluginProbe> {
    return this.run('health', [], () => {
      const script = this.healthScript ?? this.currentPlugin()
      const found = typeof script === 'function' ? script() : script
      if (found instanceof Error) {
        throw found
      }
      return found
    })
  }

  setup(): Promise<SetupState> {
    return this.run('setup', [], () => this.setupResult)
  }

  createReminder(req: ReminderRequest): Promise<ReminderOutcome> {
    return this.run('createReminder', [req], () => {
      this.checkReminder(req)
      const payloadKey = canonical([req.profile, req.schedule.trim(), req.timezone.trim(), req.prompt.trim().replace(/\s+/g, ' ')])
      const stored = this.reminders.get(req.request_id)
      if (stored) {
        if (stored.payloadKey !== payloadKey) {
          return { status: 'conflict', receipt: { ...stored.receipt } }
        }
        if (stored.receipt.state === 'created') {
          return { status: 'existing', receipt: { ...stored.receipt } }
        }
        // Reconcile an uncertain receipt by its job's name before creating.
        const job = this.jobs.find(j => j.name === stored.jobName)
        if (job) {
          stored.receipt = { ...stored.receipt, state: 'created', job_id: job.id }
          return { status: 'existing', receipt: { ...stored.receipt } }
        }
        return this.createJob(stored, req)
      }
      const label = req.label?.trim() ? req.label.trim() : 'reminder'
      const fresh: StoredReminder = {
        payloadKey,
        jobName: `[bot:${req.profile}] ${label} · ${tag(`${req.request_id}\n${payloadKey}`)}`,
        receipt: { id: req.request_id, request_id: req.request_id, profile: req.profile, state: 'creating', job_id: null, timezone_advisory: req.timezone, payload_hash: tag(payloadKey) }
      }
      this.reminders.set(req.request_id, fresh)
      const uncertain = this.uncertain.shift()
      if (uncertain) {
        if (uncertain.jobCreated) {
          this.jobs.push({ id: `job-${this.jobs.length + 1}`, profile: req.profile, name: fresh.jobName, schedule: req.schedule })
        }
        fresh.receipt = { ...fresh.receipt, state: 'uncertain' }
        return { status: 'uncertain', receipt: { ...fresh.receipt } }
      }
      return this.createJob(fresh, req)
    })
  }

  getProposal(proposalId: string): Promise<ProposalReceipt> {
    return this.run('getProposal', [proposalId], () => this.view(this.stored(proposalId)))
  }

  acceptProposal(proposalId: string, proposal: AgentProposal): Promise<ProposalReceipt> {
    return this.run('acceptProposal', [proposalId, proposal], () => {
      const stored = this.stored(proposalId)
      if (!proposal || typeof proposal !== 'object' || proposal.proposal_id !== proposalId || canonical(proposal) !== stored.hash) {
        throw c3('hash_mismatch', 'the approved payload is not the recorded proposal')
      }
      const template = this.templates[stored.proposal.agent.template_id]
      if (!template) {
        throw c3('unknown_template', `there is no template ${JSON.stringify(stored.proposal.agent.template_id)}`)
      }
      if (stored.state === 'accepted' || stored.state === 'complete') {
        return this.view(stored, template)
      }
      if (stored.state === 'rejected') {
        throw c3('not_acceptable', 'this proposal was rejected')
      }
      if (this.expired(stored)) {
        throw c3('expired', 'this proposal has expired')
      }
      const name = stored.proposal.agent.name
      const reserved = [...this.proposals.values()].some(other => other !== stored && other.state === 'accepted' && other.proposal.agent.name === name)
      if (this.hasProfile(name) || reserved) {
        throw c3('name_taken', `a profile named '${name}' already exists`)
      }
      stored.state = 'accepted'
      return this.view(stored, template)
    })
  }

  rejectProposal(proposalId: string): Promise<ProposalReceipt> {
    return this.run('rejectProposal', [proposalId], () => {
      const stored = this.stored(proposalId)
      if (stored.state === 'accepted' || stored.state === 'complete') {
        throw c3('not_acceptable', 'an accepted proposal cannot be rejected')
      }
      stored.state = 'rejected'
      return this.view(stored)
    })
  }

  recordProposalStep(proposalId: string, step: ProvisionStep, status: StepStatus): Promise<ProposalReceipt> {
    return this.run('recordProposalStep', [proposalId, step, status], () => {
      if (!PROVISION_STEPS.includes(step) || !STATUSES.includes(status)) {
        throw c3('invalid', 'unknown provisioning step or status')
      }
      const stored = this.stored(proposalId)
      if (stored.steps[step] !== 'done') {
        if (stored.state !== 'accepted') {
          throw c3('out_of_order', 'steps are recorded only for an accepted proposal')
        }
        const pending = this.nextStep(stored)
        if (pending !== step) {
          throw c3('out_of_order', `'${step}' cannot be reported before '${pending}' is done`)
        }
        stored.steps[step] = status
      }
      if (step === 'briefing' && status === 'done' && stored.state !== 'complete') {
        const name = stored.proposal.agent.name
        if (stored.state !== 'accepted' || this.nextStep(stored) !== null || !this.hasProfile(name) || !this.enabledPlugins.has(name)) {
          throw c3('not_ready', `profile '${name}' is not ready yet`)
        }
        stored.state = 'complete'
      }
      return this.view(stored)
    })
  }

  enablePlugin(profile: string): Promise<{ profile: string; enabled: boolean }> {
    return this.run('enablePlugin', [profile], () => {
      if (!PROFILE_RE.test(profile) || !this.hasProfile(profile)) {
        throw c3('unknown_profile', 'there is no profile with that name')
      }
      this.enabledPlugins.add(profile)
      return { profile, enabled: true }
    })
  }

  attentionPrefs(profile: string): Promise<AttentionPrefs> {
    return this.run('attentionPrefs', [profile], () => {
      this.checkPrefsProfile(profile)
      const stored = this.prefs.get(profile) ?? this.prefs.get('*') ?? { muted: false, quiet_start: null, quiet_end: null }
      return { profile, ...stored }
    })
  }

  setAttentionPrefs(prefs: AttentionPrefs): Promise<AttentionPrefs> {
    return this.run('setAttentionPrefs', [prefs], () => {
      this.checkPrefsProfile(prefs?.profile)
      const { muted, quiet_start: start, quiet_end: end } = prefs
      if (typeof muted !== 'boolean') {
        throw c3('invalid', 'muted must be true or false')
      }
      if ((start === null) !== (end === null)) {
        throw c3('invalid', 'set both quiet_start and quiet_end, or neither')
      }
      if ((start !== null && !CLOCK_RE.test(start)) || (end !== null && !CLOCK_RE.test(end))) {
        throw c3('invalid', 'quiet hours use HH:MM from 00:00 to 23:59')
      }
      if (start !== null && start === end) {
        throw c3('invalid', 'quiet_start and quiet_end must differ')
      }
      this.prefs.set(prefs.profile, { muted, quiet_start: start, quiet_end: end })
      return { profile: prefs.profile, muted, quiet_start: start, quiet_end: end }
    })
  }

  private async run<R>(op: ErgatesOp, args: unknown[], work: () => R): Promise<R> {
    this.calls.push({ op, args })
    const index = this.faults.findIndex(f => f.op === op)
    const fault = index >= 0 ? this.faults.splice(index, 1)[0] : undefined
    if (fault?.when === 'before') {
      return this.settle(fault)
    }
    const result = structuredClone(work())
    if (fault) {
      return this.settle(fault)
    }
    return result
  }

  private settle(fault: Fault): Promise<never> {
    return fault.error === 'hang' ? new Promise<never>(() => undefined) : Promise.reject(fault.error)
  }

  /** The health of a current plugin, with the commits as they stand now. */
  private currentPlugin(): PluginProbe {
    const install = { kind: 'git install', commit: this.installedCommit(), loaded_commit: this.loadedCommit, catalog_name: null } as const
    return { state: 'answered', health: { ...FAKE_PLUGIN_HEALTH, install } }
  }

  private checkReminder(req: ReminderRequest): void {
    if (!req || typeof req !== 'object' || typeof req.profile !== 'string' || !PROFILE_RE.test(req.profile)) {
      throw c3('invalid', 'profile must be a Hermes profile name')
    }
    if (typeof req.request_id !== 'string' || !REQUEST_ID_RE.test(req.request_id)) {
      throw c3('invalid', 'request_id is required and must be a non-empty string')
    }
    for (const [field, value] of [['schedule', req.schedule], ['timezone', req.timezone], ['prompt', req.prompt]] as const) {
      if (typeof value !== 'string' || !value.trim()) {
        throw c3('invalid', `${field} is required and must be a non-empty string`)
      }
    }
    if (!isZone(req.timezone)) {
      throw c3('invalid', 'timezone must be an IANA time zone name, for example Europe/Amsterdam')
    }
    const label = req.label
    // The server refuses a control character anywhere in a label (`str.isprintable`).
    if (label !== undefined && (typeof label !== 'string' || !label.trim() || label.length > LABEL_MAX_LEN || /[\u0000-\u001f\u007f]/.test(label))) {
      throw c3('invalid', `label must be 1 to ${LABEL_MAX_LEN} printable characters`)
    }
    if (!this.hasProfile(req.profile)) {
      throw c3('unknown_profile', `profile '${req.profile}' does not exist`)
    }
    // The fake's Hermes cron refuses exactly this schedule; the server answers a
    // schedule `hermes_adapter.check_schedule` refuses with this `invalid`.
    if (req.schedule === 'not a schedule') {
      throw c3('invalid', 'schedule is not one Hermes cron accepts')
    }
  }

  private createJob(stored: StoredReminder, req: ReminderRequest): ReminderOutcome {
    const job = { id: `job-${this.jobs.length + 1}`, profile: req.profile, name: stored.jobName, schedule: req.schedule }
    this.jobs.push(job)
    stored.receipt = { ...stored.receipt, state: 'created', job_id: job.id }
    return { status: 'created', receipt: { ...stored.receipt } }
  }

  private stored(proposalId: string): StoredProposal {
    const stored = this.proposals.get(proposalId)
    if (!stored) {
      throw c3('not_found', `no proposal '${proposalId}'`)
    }
    return stored
  }

  private expired(stored: StoredProposal): boolean {
    return stored.state === 'proposed' && this.now() > Date.parse(stored.proposal.expires_at)
  }

  private nextStep(stored: StoredProposal): ProvisionStep | null {
    return PROVISION_STEPS.find(step => stored.steps[step] !== 'done') ?? null
  }

  private view(stored: StoredProposal, template: ProposalTemplate | null = null): ProposalReceipt {
    const state = this.expired(stored) ? 'expired' : stored.state
    return {
      proposal_id: stored.proposal.proposal_id,
      state,
      reserved_profile_name: stored.proposal.agent.name,
      expires_at: stored.proposal.expires_at,
      completed_steps: PROVISION_STEPS.filter(step => stored.steps[step] === 'done'),
      step_status: Object.fromEntries(PROVISION_STEPS.filter(step => step in stored.steps).map(step => [step, stored.steps[step]])),
      next_step: state === 'proposed' || state === 'accepted' ? this.nextStep(stored) : null,
      template
    }
  }

  private checkPrefsProfile(profile: unknown): void {
    if (profile !== '*' && !(typeof profile === 'string' && PROFILE_RE.test(profile))) {
      throw c3('invalid', "profile must be '*' or a Hermes profile name")
    }
  }
}
