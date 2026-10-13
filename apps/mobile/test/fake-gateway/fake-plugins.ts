/**
 * FakePlugins: Hermes's plugin routes in memory (the hub list, install, enable
 * and disable).
 *
 * It answers with the outcomes of `dashboard_install_plugin` and
 * `dashboard_set_agent_plugin_enabled` in `hermes_cli`, built through the same
 * error mapping the real adapter uses, so an app test meets what a real Hermes
 * answers. An install with the default outcome adds the plugin its identifier
 * names (its last path segment), enabled when asked, and refuses a plugin that
 * is already there, as Hermes does without `force`. With `force` it replaces
 * the plugin, but declines while the plugin is turned on: no one can answer
 * Hermes's question about its dependencies over the REST route, so a plugin
 * is replaced only after `disable`. The replaced plugin keeps the version its
 * row shows: the fake does not know what a commit holds, so a test that needs
 * another version sets `rows`.
 * Test hooks: `rows` (the hub list), `installedCommit` (the commit of the
 * install record, which every install that places a plugin moves to its `ref`),
 * `nextInstall` (what the next install answers), `fail`; logs: `installs`,
 * `enabled`, `disabled`.
 *
 * No React Native or Expo imports (ADR-029 rule 1).
 */

import { mapHttpError, type GatewayError } from '@/gateway/errors'
import type { PluginsApi } from '@/gateway/port'
import { mapPluginInstallError } from '@/gateway/real/plugins-api'
import type { HermesPluginRow, PluginInstallRequest, PluginInstallResult } from '@/gateway/types'

import { FAKE_PLUGIN_COMMIT } from './fake-ergates'

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
  /** Every plugin name a disable was asked for, in order, failed ones included. */
  readonly disabled: string[] = []
  /** The commit the plugin's install record holds. It starts at the commit of a current plugin. */
  installedCommit: string | null = FAKE_PLUGIN_COMMIT

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
      if (!outcome) {
        this.checkReplaceable(result.plugin_name, req.force)
      }
      this.place(result, req.ref)
      return result
    })
  }

  enable(name: string): Promise<void> {
    this.enabled.push(name)
    return this.run('enable', () => {
      this.requireRow(name).runtime_status = 'enabled'
    })
  }

  disable(name: string): Promise<void> {
    this.disabled.push(name)
    return this.run('disable', () => {
      this.requireRow(name).runtime_status = 'disabled'
    })
  }

  private requireRow(name: string): HermesPluginRow {
    const row = this.rows.find(found => found.name === name)
    if (!row) {
      // `dashboard_set_agent_plugin_enabled` answers ok=false, which the route turns into this 400.
      throw mapHttpError(400, { detail: `Plugin '${name}' is not installed or bundled.` })
    }
    return row
  }

  /** What Hermes refuses before it places a plugin that is already there. */
  private checkReplaceable(name: string, force: boolean): void {
    const row = this.rows.find(found => found.name === name)
    if (!row) {
      return
    }
    if (!force) {
      throw alreadyExists(name)
    }
    if (row.runtime_status === 'enabled') {
      throw reinstallDeclined(name)
    }
  }

  private place(result: PluginInstallResult, commit: string): void {
    const runtimeStatus = result.enabled ? 'enabled' : 'inactive'
    const row = this.rows.find(found => found.name === result.plugin_name)
    if (row) {
      row.runtime_status = runtimeStatus
    } else {
      this.rows.push({ name: result.plugin_name, version: null, runtime_status: runtimeStatus })
    }
    this.installedCommit = commit
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

/**
 * The 400 of a forced install over a plugin that is turned on (`publish_plugin`
 * asks to reinstall its dependencies, and nothing can answer over REST).
 */
function reinstallDeclined(name: string): GatewayError {
  return mapPluginInstallError(400, {
    detail: `Plugin '${name}' was not published: Reinstall declined: dependency install skipped (non-interactive). The installed plugin and active environment are unchanged.`
  })
}
