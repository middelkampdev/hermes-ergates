/**
 * The Ergates integration routes over the connection's own `HttpClient`, so
 * they carry its auth: the session-token header in loopback token mode, the
 * cookie in gated mode. Hermes mounts them under `/api/plugins/ergates` from
 * the plugin's `dashboard/manifest.json`.
 * Never logs a body: a reminder carries its prompt and an accept the briefing.
 */

import { mapErgatesError } from '../errors'
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

/**
 * `ready` loads the connection's stored credential before a call (the
 * gateway's `restore()`): a cold start through a push link opens a chat
 * without Home, which is what restores it for the other routes.
 */
export function createErgatesApi(http: HttpClient, ready: () => Promise<unknown> = async () => undefined): ErgatesApi {
  const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object'
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
      return { state: 'answered', health: answer.body as unknown as T.ErgatesHealth }
    },
    setup: async () => (await call('POST', '/setup', {})).setup as T.SetupState,
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
