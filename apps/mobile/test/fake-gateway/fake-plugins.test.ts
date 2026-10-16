/**
 * The fake Hermes plugin routes answer as Hermes does (`dashboard_install_plugin`
 * and `dashboard_set_agent_plugin_enabled` in `hermes_cli`), through the same
 * error mapping as the real adapter, so app tests meet the same outcomes.
 */
import { describe, expect, it } from 'vitest'

import { GatewayError } from '@/gateway/errors'
import type { PluginInstallRequest } from '@/gateway/types'

import { FAKE_PLUGIN_COMMIT } from './fake-ergates'
import { FakePlugins } from './fake-plugins'

const request: PluginInstallRequest = { identifier: 'middelkampdev/hermes-ergates/integrations/ergates', ref: 'a'.repeat(40), enable: true, force: false }
const NEWER = 'b'.repeat(40)
const forced: PluginInstallRequest = { ...request, ref: NEWER, force: true }

/** The 400 Hermes answers when a forced install would replace a plugin that is turned on and no one can say yes to its dependencies. */
const DECLINED =
  "Plugin 'ergates' was not published: Reinstall declined: dependency install skipped (non-interactive). The installed plugin and active environment are unchanged."

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

describe('FakePlugins: turning a plugin off', () => {
  it('marks the plugin disabled and logs the name', async () => {
    const plugins = new FakePlugins()
    plugins.rows = [{ name: 'ergates', version: '0.2.0', runtime_status: 'enabled' }]

    await expect(plugins.disable('ergates')).resolves.toBeUndefined()
    await expect(plugins.hub()).resolves.toEqual([{ name: 'ergates', version: '0.2.0', runtime_status: 'disabled' }])
    expect(plugins.disabled).toEqual(['ergates'])
  })

  it('answers a plugin that is already off as done, and logs it', async () => {
    const plugins = new FakePlugins()
    plugins.rows = [{ name: 'ergates', version: '0.2.0', runtime_status: 'disabled' }]

    await expect(plugins.disable('ergates')).resolves.toBeUndefined()
    await expect(plugins.disable('ergates')).resolves.toBeUndefined()
    expect(plugins.disabled).toEqual(['ergates', 'ergates'])
  })

  it('refuses a plugin Hermes does not know, as enable does, and logs it', async () => {
    const plugins = new FakePlugins()

    const err = await plugins.disable('missing').then(
      () => undefined,
      (e: unknown) => e
    )
    expect(err).toMatchObject({ kind: 'unknown', status: 400, message: "Plugin 'missing' is not installed or bundled." })
    expect((err as GatewayError).code).toBeUndefined()
    expect(plugins.disabled).toEqual(['missing'])
  })

  it('fails the next disable before it takes effect', async () => {
    const plugins = new FakePlugins()
    plugins.rows = [{ name: 'ergates', version: '0.2.0', runtime_status: 'enabled' }]
    plugins.fail('disable', new GatewayError('network', 'No connection to the gateway.'))

    await expect(plugins.disable('ergates')).rejects.toMatchObject({ kind: 'network' })
    await expect(plugins.hub()).resolves.toEqual([{ name: 'ergates', version: '0.2.0', runtime_status: 'enabled' }])
  })

  it('fails the next disable after it took effect: the answer was lost', async () => {
    const plugins = new FakePlugins()
    plugins.rows = [{ name: 'ergates', version: '0.2.0', runtime_status: 'enabled' }]
    plugins.fail('disable', new GatewayError('network', 'No connection to the gateway.'), 'after')

    await expect(plugins.disable('ergates')).rejects.toMatchObject({ kind: 'network' })
    await expect(plugins.hub()).resolves.toEqual([{ name: 'ergates', version: '0.2.0', runtime_status: 'disabled' }])
  })
})

describe('FakePlugins: the commit of the install record', () => {
  it('starts at the commit of a current plugin', () => {
    expect(new FakePlugins().installedCommit).toBe(FAKE_PLUGIN_COMMIT)
  })

  it('moves to the commit an install placed', async () => {
    const plugins = new FakePlugins()
    plugins.installedCommit = null

    await plugins.install(request)
    expect(plugins.installedCommit).toBe(request.ref)
  })

  it('stays where a test set it when an install fails', async () => {
    const plugins = new FakePlugins()
    plugins.installedCommit = 'c'.repeat(40)
    plugins.nextInstall(new GatewayError('unknown', 'git is not installed or not in PATH.', { code: 'no_git', status: 400 }))

    await expect(plugins.install(request)).rejects.toMatchObject({ code: 'no_git' })
    expect(plugins.installedCommit).toBe('c'.repeat(40))
  })

  it('moves to the commit a scripted result placed', async () => {
    const plugins = new FakePlugins()
    plugins.nextInstall({ plugin_name: 'ergates', enabled: false })

    await plugins.install(request)
    expect(plugins.installedCommit).toBe(request.ref)
  })
})

describe('FakePlugins: the code Hermes mounts', () => {
  it('mounts the plugin of an install that places one where there was none, as Hermes does without a restart', async () => {
    const mounted: string[] = []
    const plugins = new FakePlugins({ onMount: commit => mounted.push(commit) })

    await plugins.install(request)
    expect(mounted).toEqual([request.ref])
  })

  it('mounts a plugin placed by a scripted result too', async () => {
    const mounted: string[] = []
    const plugins = new FakePlugins({ onMount: commit => mounted.push(commit) })
    plugins.nextInstall({ plugin_name: 'ergates', enabled: false })

    await plugins.install(request)
    expect(mounted).toEqual([request.ref])
  })

  it('mounts nothing when it replaces a plugin that is already there: Hermes keeps the routes it mounted', async () => {
    const mounted: string[] = []
    const plugins = new FakePlugins({ onMount: commit => mounted.push(commit) })
    plugins.rows = [{ name: 'ergates', version: '0.2.0', runtime_status: 'disabled' }]

    await plugins.install(forced)
    expect(mounted).toEqual([])
  })

  it('mounts nothing when an install fails', async () => {
    const mounted: string[] = []
    const plugins = new FakePlugins({ onMount: commit => mounted.push(commit) })
    plugins.nextInstall(new GatewayError('unknown', 'git is not installed or not in PATH.', { code: 'no_git', status: 400 }))

    await expect(plugins.install(request)).rejects.toMatchObject({ code: 'no_git' })
    expect(mounted).toEqual([])
  })
})

describe('FakePlugins: a forced install', () => {
  it('replaces a plugin that is turned off, enables it again and moves the commit', async () => {
    const plugins = new FakePlugins()
    plugins.rows = [{ name: 'ergates', version: '0.2.0', runtime_status: 'disabled' }]

    await expect(plugins.install(forced)).resolves.toEqual({ plugin_name: 'ergates', enabled: true })
    await expect(plugins.hub()).resolves.toEqual([{ name: 'ergates', version: '0.2.0', runtime_status: 'enabled' }])
    expect(plugins.installedCommit).toBe(NEWER)
    expect(plugins.installs).toEqual([forced])
  })

  it('replaces a plugin that was installed but never turned on', async () => {
    const plugins = new FakePlugins()
    plugins.rows = [{ name: 'ergates', version: '0.2.0', runtime_status: 'inactive' }]

    await expect(plugins.install(forced)).resolves.toEqual({ plugin_name: 'ergates', enabled: true })
    expect(plugins.installedCommit).toBe(NEWER)
  })

  it('installs a plugin that is not there yet', async () => {
    const plugins = new FakePlugins()

    await expect(plugins.install(forced)).resolves.toEqual({ plugin_name: 'ergates', enabled: true })
    await expect(plugins.hub()).resolves.toEqual([{ name: 'ergates', version: null, runtime_status: 'enabled' }])
  })

  it('declines to replace a plugin that is turned on, with Hermes\'s code-less 400, and changes nothing', async () => {
    const plugins = new FakePlugins()
    plugins.rows = [{ name: 'ergates', version: '0.2.0', runtime_status: 'enabled' }]

    const err = await plugins.install(forced).then(
      () => undefined,
      (e: unknown) => e
    )
    expect(err).toMatchObject({ kind: 'unknown', status: 400, message: DECLINED })
    expect((err as GatewayError).code).toBeUndefined()
    await expect(plugins.hub()).resolves.toEqual([{ name: 'ergates', version: '0.2.0', runtime_status: 'enabled' }])
    expect(plugins.installedCommit).toBe(FAKE_PLUGIN_COMMIT)
    expect(plugins.installs).toEqual([forced])
  })

  it('works after disable, the way an update runs', async () => {
    const plugins = new FakePlugins()
    plugins.rows = [{ name: 'ergates', version: '0.2.0', runtime_status: 'enabled' }]

    await plugins.disable('ergates')
    await expect(plugins.install(forced)).resolves.toEqual({ plugin_name: 'ergates', enabled: true })
    await expect(plugins.hub()).resolves.toEqual([{ name: 'ergates', version: '0.2.0', runtime_status: 'enabled' }])
    expect(plugins.installedCommit).toBe(NEWER)
  })

  it('still refuses a plugin that is there when the request does not force', async () => {
    const plugins = new FakePlugins()
    plugins.rows = [{ name: 'ergates', version: '0.2.0', runtime_status: 'disabled' }]

    await expect(plugins.install({ ...forced, force: false })).rejects.toMatchObject({ status: 400, code: 'already_installed' })
    expect(plugins.installedCommit).toBe(FAKE_PLUGIN_COMMIT)
  })

  it('answers as scripted over a plugin that is turned on', async () => {
    const plugins = new FakePlugins()
    plugins.rows = [{ name: 'ergates', version: '0.2.0', runtime_status: 'enabled' }]
    plugins.nextInstall({ plugin_name: 'ergates', enabled: false })

    await expect(plugins.install(forced)).resolves.toEqual({ plugin_name: 'ergates', enabled: false })
    await expect(plugins.hub()).resolves.toEqual([{ name: 'ergates', version: '0.2.0', runtime_status: 'inactive' }])
  })
})
