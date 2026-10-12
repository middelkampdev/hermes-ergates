/**
 * The fake Hermes plugin routes answer as Hermes does (`dashboard_install_plugin`
 * and `dashboard_set_agent_plugin_enabled` in `hermes_cli`), through the same
 * error mapping as the real adapter, so app tests meet the same outcomes.
 */
import { describe, expect, it } from 'vitest'

import { GatewayError } from '@/gateway/errors'
import type { PluginInstallRequest } from '@/gateway/types'

import { FakePlugins } from './fake-plugins'

const request: PluginInstallRequest = { identifier: 'middelkampdev/hermes-ergates/integrations/ergates', ref: 'a'.repeat(40), enable: true, force: false }

describe('FakePlugins', () => {
  it('lists the rows it is set to, as copies', async () => {
    const plugins = new FakePlugins()
    plugins.rows = [{ name: 'ergates', version: '0.2.0', runtime_status: 'disabled' }]

    const listed = await plugins.hub()
    listed[0]!.runtime_status = 'enabled'
    await expect(plugins.hub()).resolves.toEqual([{ name: 'ergates', version: '0.2.0', runtime_status: 'disabled' }])
  })

  it('installs and enables the plugin the identifier names, and logs the request', async () => {
    const plugins = new FakePlugins()

    await expect(plugins.install(request)).resolves.toEqual({ plugin_name: 'ergates', enabled: true })
    expect(plugins.installs).toEqual([request])
    await expect(plugins.hub()).resolves.toEqual([{ name: 'ergates', version: null, runtime_status: 'enabled' }])
  })

  it('refuses a second install of the same plugin with Hermes\'s already-exists answer', async () => {
    const plugins = new FakePlugins()
    await plugins.install(request)

    await expect(plugins.install(request)).rejects.toMatchObject({ kind: 'unknown', status: 400, code: 'already_installed' })
    expect(plugins.installs).toHaveLength(2)
  })

  it('answers the next install as scripted: an error changes nothing', async () => {
    const plugins = new FakePlugins()
    plugins.nextInstall(new GatewayError('unknown', 'git is not installed or not in PATH.', { code: 'no_git', status: 400 }))

    await expect(plugins.install(request)).rejects.toMatchObject({ code: 'no_git' })
    await expect(plugins.hub()).resolves.toEqual([])
    await expect(plugins.install(request)).resolves.toEqual({ plugin_name: 'ergates', enabled: true })
  })

  it('answers the next install as scripted: a result puts that plugin in the list', async () => {
    const plugins = new FakePlugins()
    plugins.nextInstall({ plugin_name: 'ergates', enabled: false })

    await expect(plugins.install(request)).resolves.toEqual({ plugin_name: 'ergates', enabled: false })
    await expect(plugins.hub()).resolves.toEqual([{ name: 'ergates', version: null, runtime_status: 'inactive' }])
  })

  it('enables an installed plugin, logs it, and refuses one Hermes does not know', async () => {
    const plugins = new FakePlugins()
    plugins.rows = [{ name: 'ergates', version: '0.2.0', runtime_status: 'disabled' }]

    await expect(plugins.enable('ergates')).resolves.toBeUndefined()
    await expect(plugins.hub()).resolves.toEqual([{ name: 'ergates', version: '0.2.0', runtime_status: 'enabled' }])
    const err = await plugins.enable('missing').then(
      () => undefined,
      (e: unknown) => e
    )
    expect(err).toMatchObject({ kind: 'unknown', status: 400, message: "Plugin 'missing' is not installed or bundled." })
    expect((err as GatewayError).code).toBeUndefined()
    expect(plugins.enabled).toEqual(['ergates', 'missing'])
  })

  it('fails the next call of one route before it takes effect', async () => {
    const plugins = new FakePlugins()
    plugins.fail('install', new GatewayError('network', 'No connection to the gateway.'))

    await expect(plugins.install(request)).rejects.toMatchObject({ kind: 'network' })
    await expect(plugins.hub()).resolves.toEqual([])
    await expect(plugins.install(request)).resolves.toMatchObject({ plugin_name: 'ergates' })
  })

  it('fails the next call after it took effect: the answer was lost', async () => {
    const plugins = new FakePlugins()
    plugins.fail('install', new GatewayError('network', 'No connection to the gateway.'), 'after')

    await expect(plugins.install(request)).rejects.toMatchObject({ kind: 'network' })
    await expect(plugins.hub()).resolves.toEqual([{ name: 'ergates', version: null, runtime_status: 'enabled' }])
  })

  it('never answers a call that is set to hang', async () => {
    const plugins = new FakePlugins()
    plugins.fail('hub', 'hang')

    const outcome = await Promise.race([
      plugins.hub().then(
        () => 'answered',
        () => 'answered'
      ),
      new Promise<string>(resolve => setTimeout(() => resolve('pending'), 5))
    ])
    expect(outcome).toBe('pending')
  })
})
