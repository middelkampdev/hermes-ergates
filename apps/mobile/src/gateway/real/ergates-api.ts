/**
 * The Ergates integration routes over the connection's own `HttpClient`, so
 * they carry its auth: the session-token header in loopback token mode, the
 * cookie in gated mode. Hermes mounts them under `/api/plugins/ergates` from
 * the plugin's `dashboard/manifest.json`.
 * Never logs a body: a reminder carries its prompt and an accept the briefing.
 */

import { GatewayError, mapErgatesError } from '../errors'
import type { ErgatesApi } from '../port'
import type * as T from '../types'
import messages from './hermes-plugin-messages.json'
import type { HttpClient } from './http'

export const ERGATES_BASE = '/api/plugins/ergates'

/**
 * `POST /reminders` can block: the first Hermes cron create in a fresh server
 * process takes 3 to 12 s, and a second identical request waits up to 5 s for
 * the first. Every other route answers from the control store.
 */
export const REMINDER_TIMEOUT_MS = 60_000

const REMINDER_STATUS: Partial<Record<number, T.ReminderOutcome['status']>> = { 201: 'created', 200: 'existing', 202: 'uncertain' }

const INSTALL_KINDS: readonly unknown[] = ['git install', 'manual copy'] satisfies NonNullable<T.ErgatesHealth['install']>['kind'][]

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object'

/**
 * A health body with an `install` the app can read. A kind it does not know
 * reads as a manual copy, which the app only asks to update by hand; an
 * `install` that is not an object is left out, as an older plugin sends none.
 * A `loaded_commit` that is not a string reads as `null`; one the plugin does
 * not send stays out, which is what tells an older plugin from a manual copy.
 * Every other field stays as the plugin sent it.
 */
function readHealth(body: Record<string, unknown>): T.ErgatesHealth {
  const { install, ...withoutInstall } = body
  if (install === undefined) {
    return body as unknown as T.ErgatesHealth
  }
  if (!isObject(install)) {
    return withoutInstall as unknown as T.ErgatesHealth
  }
  const kind = INSTALL_KINDS.includes(install.kind) ? install.kind : 'manual copy'
  const loaded = 'loaded_commit' in install ? { loaded_commit: typeof install.loaded_commit === 'string' ? install.loaded_commit : null } : {}
  return { ...body, install: { ...install, kind, ...loaded } } as unknown as T.ErgatesHealth
}

/**
 * `ready` loads the connection's stored credential before a call (the
 * gateway's `restore()`): a cold start through a push link opens a chat
 * without Home, which is what restores it for the other routes.
 */
export function createErgatesApi(http: HttpClient, ready: () => Promise<unknown> = async () => undefined): ErgatesApi {
  const exchange = async (method: string, path: string, body?: unknown) => {
    await ready()
    return http.exchange(method, `${ERGATES_BASE}${path}`, body)
  }
  /** A 2xx JSON object, or the Ergates error as a `GatewayError`. */
  const call = async (method: string, path: string, body?: unknown): Promise<Record<string, unknown>> => {
    const answer = await exchange(method, path, body)
    if (answer.status < 200 || answer.status >= 300 || !isObject(answer.body)) {
      throw mapErgatesError(answer.status, answer.body)
    }
    return answer.body
  }
  const proposal = (id: string, suffix = '') => `/proposals/${encodeURIComponent(id)}${suffix}`

  return {
    health: async () => {
      const answer = await exchange('GET', '/health')
      if (answer.status === 404) {
        // Hermes words the two 404s differently: the first when it does not serve the plugin at all,
        // the second when the plugin is enabled but its routes never mounted.
        const detail = isObject(answer.body) ? answer.body.detail : undefined
        return { state: detail === messages.pluginNotFound ? 'absent' : 'not_loaded' }
      }
      if (answer.status < 200 || answer.status >= 300 || !isObject(answer.body)) {
        throw mapErgatesError(answer.status, answer.body)
      }
      return { state: 'answered', health: readHealth(answer.body) }
    },
    setup: async () => {
      const { setup } = await call('POST', '/setup', {})
      // The setup screen lists the profiles the report names; a report without them is no report.
      if (!isObject(setup) || !Array.isArray(setup.profiles)) {
        throw new GatewayError('unknown', 'The plugin did not answer with a setup report.')
      }
      return setup as unknown as T.SetupState
    },
    createReminder: async req => {
      await ready()
      const answer = await http.exchange('POST', `${ERGATES_BASE}/reminders`, req, { timeoutMs: REMINDER_TIMEOUT_MS })
      const body = answer.body as { receipt?: T.ReminderReceipt; error?: { code?: unknown } } | undefined
      const status = REMINDER_STATUS[answer.status]
      if (status && body?.receipt) {
        return { status, receipt: body.receipt }
      }
      if (answer.status === 409 && body?.error?.code === 'conflict' && body.receipt) {
        return { status: 'conflict', receipt: body.receipt }
      }
      throw mapErgatesError(answer.status, answer.body)
    },
    getProposal: async id => (await call('GET', proposal(id))).proposal as T.ProposalReceipt,
    acceptProposal: async (id, payload) => (await call('POST', proposal(id, '/accept'), { proposal: payload })).proposal as T.ProposalReceipt,
    rejectProposal: async id => (await call('POST', proposal(id, '/reject'))).proposal as T.ProposalReceipt,
    recordProposalStep: async (id, step, status) => (await call('POST', proposal(id, '/steps'), { step, status })).proposal as T.ProposalReceipt,
    enablePlugin: async profile => (await call('POST', `/profiles/${encodeURIComponent(profile)}/plugin`)) as { profile: string; enabled: boolean },
    attentionPrefs: async scope => (await call('GET', `/attention/prefs?${new URLSearchParams({ scope }).toString()}`)).prefs as T.AttentionPrefs,
    setAttentionPrefs: async prefs => (await call('PUT', '/attention/prefs', prefs)).prefs as T.AttentionPrefs
  }
}
