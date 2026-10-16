/**
 * The fake gateway must fail the way the real client fails, or a scenario can
 * pass against a behavior the app never meets.
 */
import { describe, expect, it } from 'vitest'

import { GatewayError } from '@/gateway/errors'
import type * as T from '@/gateway/types'

import { FakeGateway, type FakeConnection } from './fake-gateway'

describe('FakeGateway', () => {
  it('rejects a request on a closed socket at once, as the vendored client does', async () => {
    // vendor/hermes/shared/json-rpc-gateway.ts `request`: a socket that is not
    // OPEN rejects before anything is sent; the adapter maps that to `network`.
    const gateway = new FakeGateway()
    const conn = (await gateway.connect('thijs')) as FakeConnection
    conn.simulateOffline()

    await expect(conn.request('prompt.submit', { session_id: 's1', text: 'hello' })).rejects.toMatchObject({ name: 'GatewayError', kind: 'network' })
    expect(conn.submitCalls).toBe(0)
    expect(conn.methods()).toEqual([])

    conn.simulateOnline()
    await expect(conn.request('prompt.submit', { session_id: 's1', text: 'hello' })).resolves.toEqual({ status: 'streaming' })
    expect(conn.submitCalls).toBe(1)
  })
})

describe('FakeGateway status', () => {
  it('reports the recorded Hermes version until a test sets another', async () => {
    const gateway = new FakeGateway()
    const recorded = (await gateway.status()).version

    gateway.setHermesVersion('0.99.1')
    expect((await gateway.status()).version).toBe('0.99.1')
    expect(recorded).not.toBe('0.99.1')
  })

  it('keeps the rest of the recorded status when it sets a version', async () => {
    const gateway = new FakeGateway()
    const recorded = await gateway.status()

    gateway.setHermesVersion('unknown')

    expect(await gateway.status()).toEqual({ ...recorded, version: 'unknown' })
  })

  it('rejects with the error a test sets', async () => {
    const gateway = new FakeGateway()
    gateway.setHermesVersion(new GatewayError('network', 'No connection to the gateway.'))

    await expect(gateway.status()).rejects.toMatchObject({ kind: 'network' })
  })
})

describe('FakeGateway status and login counters', () => {
  it('counts every status and login call, from zero', async () => {
    const gateway = new FakeGateway()
    expect(gateway.statusCalls).toBe(0)
    expect(gateway.loginCalls).toBe(0)

    await gateway.status()
    await gateway.status()
    await gateway.login()

    expect(gateway.statusCalls).toBe(2)
    expect(gateway.loginCalls).toBe(1)
  })

  it('counts a status call that rejects', async () => {
    const gateway = new FakeGateway()
    gateway.setHermesVersion(new GatewayError('network', 'No connection to the gateway.'))

    await expect(gateway.status()).rejects.toMatchObject({ kind: 'network' })

    expect(gateway.statusCalls).toBe(1)
  })

  it('reports the recorded plain status until a test asks for the gated one', async () => {
    const gateway = new FakeGateway()
    expect(await gateway.status()).toMatchObject({ auth_required: false, auth_providers: [] })

    gateway.requirePassword()

    expect(await gateway.status()).toMatchObject({ auth_required: true, auth_providers: ['basic'] })
  })

  it('keeps a version a test set on the gated status', async () => {
    const gateway = new FakeGateway()
    gateway.requirePassword()
    gateway.setHermesVersion('0.99.1')

    expect(await gateway.status()).toMatchObject({ auth_required: true, version: '0.99.1' })
  })
})

describe('FakeGateway profile metadata', () => {
  const hermesBots = async (gateway: FakeGateway, name: string) => {
    const profile = (await gateway.profiles.list()).profiles.find(p => p.name === name)
    return { meta: profile?.ui_meta?.['hermes-bots'], revision: profile?.ui_meta_revisions?.['hermes-bots'] }
  }

  it('replaces a ui_meta namespace like profiles.configure, keeps the other namespaces, and counts its revision up', async () => {
    const gateway = new FakeGateway()
    const result = await gateway.profiles.configure({
      name: 'kevin',
      ui_meta: { 'hermes-bots': { title: 'Kevin', pinned: true, sectionId: 'sec-1', sectionName: 'Clients' } },
      ui_meta_expected_revisions: { 'hermes-bots': 2 }
    })
    expect(result).toEqual({ ok: true, applied: { ui_meta: true, ui_meta_revisions: { 'hermes-bots': 3 } } })
    expect(await hermesBots(gateway, 'kevin')).toEqual({ meta: { title: 'Kevin', pinned: true, sectionId: 'sec-1', sectionName: 'Clients' }, revision: 3 })
    expect((await gateway.profiles.list()).profiles.find(p => p.name === 'kevin')?.ui_meta?.ergates).toEqual({ role: 'Trainer' })
    expect(gateway.configureCalls.map(call => call.name)).toEqual(['kevin'])
  })

  it('refuses a write that names an old revision, and applies none of it', async () => {
    const gateway = new FakeGateway()
    gateway.desktopWrite('kevin', { pinned: true })
    expect(await hermesBots(gateway, 'kevin')).toMatchObject({ meta: { title: 'Kevin', pinned: true }, revision: 3 })
    const result = await gateway.profiles.configure({ name: 'kevin', ui_meta: { 'hermes-bots': { pinned: false } }, ui_meta_expected_revisions: { 'hermes-bots': 2 } })
    expect(result).toEqual({
      ok: false,
      applied: { ui_meta: false, ui_meta_conflicts: { 'hermes-bots': { expected: 2, actual: 3 } }, ui_meta_revisions: { 'hermes-bots': 3 } }
    })
    expect(await hermesBots(gateway, 'kevin')).toMatchObject({ meta: { pinned: true }, revision: 3 })
  })

  it('fails profile calls like a lost connection while offline', async () => {
    const gateway = new FakeGateway()
    gateway.profilesOffline = true
    await expect(gateway.profiles.list()).rejects.toMatchObject({ name: 'GatewayError', kind: 'network' })
    await expect(gateway.profiles.configure({ name: 'kevin', ui_meta: {} })).rejects.toMatchObject({ kind: 'network' })
    gateway.profilesOffline = false
    await expect(gateway.profiles.configure({ name: 'nobody', ui_meta: {} })).rejects.toMatchObject({ kind: 'rpc' })
  })
})

describe('FakeGateway server requests', () => {
  it('delivers a request again with replayed set on resume, activate and replay, and lists it as open_requests', async () => {
    const gateway = new FakeGateway()
    const conn = (await gateway.connect('thijs')) as FakeConnection
    const resumed = await gateway.sessions.resume({ session_id: 'stored-1', profile: 'thijs' })
    const seen: T.ServerRequestFrame[] = []
    conn.onRequest(r => seen.push(r))
    const open = { id: 'srq-0000000000f1', method: 'approval', params: { session_id: resumed.session_id, request_id: 'ap1' } }
    conn.serverRequest(open)
    conn.serverRequest({ id: 'srq-0000000000f2', method: 'approval', params: { session_id: 'other', request_id: 'ap2' } })

    expect((await gateway.sessions.resume({ session_id: 'stored-1', profile: 'thijs' })).open_requests).toEqual([open])
    expect((await gateway.sessions.activate(resumed.session_id)).open_requests).toEqual([open])
    expect((await conn.replay(resumed.session_id, 0)).open_requests).toEqual([open])
    expect(seen.map(r => [r.id, r.replayed])).toEqual([
      ['srq-0000000000f1', false],
      ['srq-0000000000f2', false],
      ['srq-0000000000f1', true],
      ['srq-0000000000f1', true],
      ['srq-0000000000f1', true]
    ])
  })

  it('answers a request once, and maps an answer that cannot go out like the real gateway', async () => {
    const gateway = new FakeGateway()
    const conn = (await gateway.connect('thijs')) as FakeConnection
    const { session_id: live } = await gateway.sessions.resume({ session_id: 'stored-1', profile: 'thijs' })
    conn.serverRequest({ id: 'srq-0000000000f3', method: 'approval', params: { session_id: live, request_id: 'ap3' } })
    conn.serverRequest({ id: 'srq-0000000000f4', method: 'clarify', params: { session_id: live, questions: [{ qid: 'q0', question: 'Tea?' }] } })

    conn.simulateOffline()
    await expect(gateway.sessions.respondApproval({ session_id: live, request_id: 'srq-0000000000f3', choice: 'deny' })).rejects.toMatchObject({ kind: 'network' })
    conn.simulateOnline()
    await gateway.sessions.respondApproval({ session_id: live, request_id: 'srq-0000000000f3', choice: 'deny' })
    await expect(gateway.sessions.respondApproval({ session_id: live, request_id: 'srq-0000000000f3', choice: 'once' })).rejects.toMatchObject({ kind: 'not_found' })
    conn.cancelRequest('srq-0000000000f4', 'timeout')
    await expect(gateway.sessions.respondClarify({ session_id: live, request_id: 'srq-0000000000f4', answers: { q0: 'A' } })).rejects.toMatchObject({ kind: 'not_found' })

    expect(conn.responses).toEqual([{ id: 'srq-0000000000f3', result: { choice: 'deny' } }])
    expect(conn.openRequestsFor(live)).toEqual([])
  })
})

describe('FakeGateway plugin update', () => {
  const NEWER = 'b'.repeat(40)

  it('runs the code of a plugin installed where there was none, because Hermes mounts it without a restart', async () => {
    const gateway = new FakeGateway()

    await gateway.plugins.install({ identifier: 'middelkampdev/hermes-ergates/integrations/ergates', ref: NEWER, enable: true, force: false })
    const probe = await gateway.ergates.health()

    expect(probe).toMatchObject({ state: 'answered', health: { install: { commit: NEWER, loaded_commit: NEWER } } })
  })

  it('moves the install record at a reinstall and the loaded commit only at a restart', async () => {
    const gateway = new FakeGateway()
    gateway.plugins.rows = [{ name: 'ergates', version: '0.2.0', runtime_status: 'enabled' }]
    const commits = async () => {
      const probe = await gateway.ergates.health()
      return probe.state === 'answered' ? [probe.health.install?.commit, probe.health.install?.loaded_commit] : []
    }
    const before = (await commits())[0]

    await gateway.plugins.disable('ergates')
    await gateway.plugins.install({ identifier: 'middelkampdev/hermes-ergates/integrations/ergates', ref: NEWER, enable: true, force: true })
    await expect(commits()).resolves.toEqual([NEWER, before])

    gateway.ergates.loadedCommit = NEWER
    await expect(commits()).resolves.toEqual([NEWER, NEWER])
  })
})

describe('FakeGateway plugin routes', () => {
  const NAME = 'ergates'
  const answers = async (gateway: FakeGateway) => (await gateway.ergates.health()).state

  it('answers for a plugin the hub does not list, as the recorded world does', async () => {
    await expect(answers(new FakeGateway())).resolves.toBe('answered')
  })

  it.each(['disabled', 'inactive'] as const)('does not serve the routes of a plugin that is %s', async status => {
    const gateway = new FakeGateway()
    gateway.plugins.rows = [{ name: NAME, version: '0.2.0', runtime_status: status }]

    await expect(answers(gateway)).resolves.toBe('absent')
  })

  it('serves the routes again once the plugin is enabled, and not while it is turned off', async () => {
    const gateway = new FakeGateway()
    gateway.plugins.rows = [{ name: NAME, version: '0.2.0', runtime_status: 'enabled' }]
    await expect(answers(gateway)).resolves.toBe('answered')

    await gateway.plugins.disable(NAME)
    await expect(answers(gateway)).resolves.toBe('absent')
    await gateway.plugins.enable(NAME)

    await expect(answers(gateway)).resolves.toBe('answered')
  })

  it('ignores the rows of other plugins', async () => {
    const gateway = new FakeGateway()
    gateway.plugins.rows = [{ name: 'other', version: null, runtime_status: 'disabled' }]

    await expect(answers(gateway)).resolves.toBe('answered')
  })

  it('keeps the health a test sets, whatever the row says', async () => {
    const gateway = new FakeGateway()
    gateway.plugins.rows = [{ name: NAME, version: '0.2.0', runtime_status: 'disabled' }]
    gateway.ergates.setHealth({ state: 'not_loaded' })

    await expect(answers(gateway)).resolves.toBe('not_loaded')
  })
})
