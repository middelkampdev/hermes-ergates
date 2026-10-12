/**
 * Hermes's own plugin routes over the connection's `HttpClient`, so they carry
 * its auth: the session-token header in loopback token mode, the cookie in
 * gated mode. The app reads the plugin list (`/api/dashboard/plugins/hub`),
 * installs a plugin and enables it (`/api/dashboard/agent-plugins`).
 *
 * Hermes answers every install refusal as a 400 with a plain-text `detail`
 * and no error code, so the failures the app tells apart are matched by the
 * text's start. Those prefixes live in `hermes-plugin-messages.json`, which the
 * contract suite checks against the pinned Hermes source. A 400 that matches
 * none keeps no code.
 * Never logs a body: an install failure can quote a repository address.
 */

import { GatewayError, mapHttpError, redact } from '../errors'
import { PLUGIN_INSTALL_TIMEOUT_MS, type PluginsApi } from '../port'
import type * as T from '../types'
import messages from './hermes-plugin-messages.json'
import type { HttpClient } from './http'

const HUB_PATH = '/api/dashboard/plugins/hub'
const AGENT_PLUGINS_PATH = '/api/dashboard/agent-plugins'

const MESSAGE_LIMIT = 200
const RUNTIME_STATUSES: readonly T.HermesPluginRow['runtime_status'][] = ['enabled', 'disabled', 'inactive']
const INSTALL_PREFIXES = Object.entries(messages.install) as [T.PluginInstallCode, string[]][]

/** The code of the first install failure whose prefix starts `detail`. */
function installCode(detail: unknown): T.PluginInstallCode | undefined {
  if (typeof detail !== 'string') {
    return undefined
  }
  return INSTALL_PREFIXES.find(([, prefixes]) => prefixes.some(prefix => detail.startsWith(prefix)))?.[0]
}

/**
 * An install refusal as a `GatewayError`: the usual kind for the status, the
 * detail as the message (redacted, at most 200 characters), and, for a 400
 * whose detail Hermes words as a failure the app knows, that failure's code.
 */
export function mapPluginInstallError(status: number, body: unknown): GatewayError {
  const base = mapHttpError(status, body)
  const detail = body && typeof body === 'object' ? (body as { detail?: unknown }).detail : undefined
  const code = status === 400 ? installCode(detail) : undefined
  return new GatewayError(base.kind, redact(base.message).slice(0, MESSAGE_LIMIT), { code, status, data: body })
}

function row(value: unknown): T.HermesPluginRow | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const { name, version, runtime_status: status } = value as Record<string, unknown>
  if (typeof name !== 'string' || !name) {
    return null
  }
  return {
    name,
    version: typeof version === 'string' && version ? version : null,
    runtime_status: RUNTIME_STATUSES.find(known => known === status) ?? 'inactive'
  }
}

/**
 * `ready` loads the connection's stored credential before a call (the
 * gateway's `restore()`), as for `createErgatesApi`.
 */
export function createPluginsApi(http: HttpClient, ready: () => Promise<unknown> = async () => undefined): PluginsApi {
  return {
    hub: async () => {
      await ready()
      const answer = await http.exchange('GET', HUB_PATH)
      if (answer.status < 200 || answer.status >= 300) {
        throw mapHttpError(answer.status, answer.body)
      }
      const plugins = answer.body && typeof answer.body === 'object' ? (answer.body as { plugins?: unknown }).plugins : undefined
      if (!Array.isArray(plugins)) {
        throw new GatewayError('unknown', 'The gateway did not answer with a plugin list.', { status: answer.status })
      }
      return plugins.map(row).filter((found): found is T.HermesPluginRow => found !== null)
    },
    install: async req => {
      await ready()
      const answer = await http.exchange('POST', `${AGENT_PLUGINS_PATH}/install`, req, { timeoutMs: PLUGIN_INSTALL_TIMEOUT_MS })
      if (answer.status < 200 || answer.status >= 300) {
        throw mapPluginInstallError(answer.status, answer.body)
      }
      const { plugin_name: name, enabled } = (answer.body && typeof answer.body === 'object' ? answer.body : {}) as Record<string, unknown>
      if (typeof name !== 'string' || !name) {
        throw new GatewayError('unknown', 'The gateway did not say which plugin it installed.', { status: answer.status })
      }
      return { plugin_name: name, enabled: enabled === true }
    },
    enable: async name => {
      await ready()
      const answer = await http.exchange('POST', `${AGENT_PLUGINS_PATH}/${encodeURIComponent(name)}/enable`)
      if (answer.status < 200 || answer.status >= 300) {
        throw mapHttpError(answer.status, answer.body)
      }
    }
  }
}
