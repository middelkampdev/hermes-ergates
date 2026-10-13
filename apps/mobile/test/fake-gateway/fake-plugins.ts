/**
 * FakePlugins: Hermes's plugin routes in memory (the hub list, install and
 * enable).
 *
 * It answers with the outcomes of `dashboard_install_plugin` and
 * `dashboard_set_agent_plugin_enabled` in `hermes_cli`, built through the same
 * error mapping the real adapter uses, so an app test meets what a real Hermes
 * answers. An install with the default outcome adds the plugin its identifier
 * names (its last path segment), enabled when asked, and refuses a plugin that
 * is already there, as Hermes does without `force`.
 * Test hooks: `rows` (the hub list), `nextInstall` (what the next install
 * answers), `fail`; logs: `installs`, `enabled`.
 *
 * No React Native or Expo imports (ADR-029 rule 1).
 */

import { mapHttpError, type GatewayError } from '@/gateway/errors'
import type { PluginsApi } from '@/gateway/port'
import { mapPluginInstallError } from '@/gateway/real/plugins-api'
import type { HermesPluginRow, PluginInstallRequest, PluginInstallResult } from '@/gateway/types'

export type PluginsOp = keyof PluginsApi

interface Fault {
  op: PluginsOp
  error: Error | 'hang'
  when: 'before' | 'after'
}

export class FakePlugins implements PluginsApi {
  /** What the hub lists. Set it to start from a server that already has plugins. */
  rows: HermesPluginRow[] = []
  /** Every install request, in order, failed ones included. */
  readonly installs: PluginInstallRequest[] = []
  /** Every plugin name an enable was asked for, in order, failed ones included. */
  readonly enabled: string[] = []

  private readonly faults: Fault[] = []
  private readonly scripted: (PluginInstallResult | Error)[] = []

  /**
   * The next install answers `outcome`: an error rejects and changes nothing;
   * a result puts that plugin in the list, enabled when the result says so.
   */
  nextInstall(outcome: PluginInstallResult | Error): void {
    this.scripted.push(outcome)
  }

  /**
   * The next call of `op` fails with `error` (or never settles, `'hang'`):
   * `before` it takes effect, or `after` it did (the answer was lost).
   */
  fail(op: PluginsOp, error: Error | 'hang', when: 'before' | 'after' = 'before'): void {
    this.faults.push({ op, error, when })
  }

  hub(): Promise<HermesPluginRow[]> {
    return this.run('hub', () => this.rows)
  }

  install(req: PluginInstallRequest): Promise<PluginInstallResult> {
    this.installs.push(structuredClone(req))
    return this.run('install', () => {
      const outcome = this.scripted.shift()
      if (outcome instanceof Error) {
        throw outcome
      }
      const result = outcome ?? { plugin_name: req.identifier.split('/').pop() ?? '', enabled: req.enable }
      if (!outcome && this.rows.some(row => row.name === result.plugin_name)) {
        throw alreadyExists(result.plugin_name)
      }
      this.place(result)
      return result
    })
  }

  enable(name: string): Promise<void> {
    this.enabled.push(name)
    return this.run('enable', () => {
      const row = this.rows.find(found => found.name === name)
      if (!row) {
        // `dashboard_set_agent_plugin_enabled` answers ok=false, which the route turns into this 400.
        throw mapHttpError(400, { detail: `Plugin '${name}' is not installed or bundled.` })
      }
      row.runtime_status = 'enabled'
    })
  }

  private place(result: PluginInstallResult): void {
    const runtimeStatus = result.enabled ? 'enabled' : 'inactive'
    const row = this.rows.find(found => found.name === result.plugin_name)
    if (row) {
      row.runtime_status = runtimeStatus
    } else {
      this.rows.push({ name: result.plugin_name, version: null, runtime_status: runtimeStatus })
    }
  }

  private async run<R>(op: PluginsOp, work: () => R): Promise<R> {
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
}

/** The 400 of an install over a plugin that is already in place (`_place_tree` without `force`). */
function alreadyExists(name: string): GatewayError {
  return mapPluginInstallError(400, { detail: `Plugin '${name}' already exists. Use force reinstall or run \`hermes plugins update ${name}\`.` })
}
