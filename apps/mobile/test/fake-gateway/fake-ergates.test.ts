/**
 * The fake Ergates routes answer as the integration does
 * (`integrations/ergates/ergates/operations.py`), so app tests meet the same
 * outcomes and error codes as the real server.
 */
import { describe, expect, it } from 'vitest'

import { GatewayError, isGatewayError, mapErgatesError } from '@/gateway/errors'
import type { AgentProposal, ReminderRequest, SetupState } from '@/gateway/types'

import { FAKE_PLUGIN_COMMIT, FakeErgates, PROPOSAL_TEMPLATE } from './fake-ergates'

const request = (over: Partial<ReminderRequest> = {}): ReminderRequest => ({
  profile: 'thijs',
  schedule: '0 9 * * *',
  timezone: 'Europe/Amsterdam',
  prompt: 'Check the unpaid invoices.',
  request_id: 'rem-1',
  label: 'Invoices',
  ...over
})

function proposalFor(name: string, over: Partial<AgentProposal> = {}): AgentProposal {
  return {
    kind: 'ergates.agent-proposal.v1',
    proposal_id: `p-${name}`,
    expires_at: '2026-09-26T10:00:00Z',
    source_session_id: 'concierge-1',
    agent: { name, title: 'Pim', role: 'Bookkeeper', description: 'Keeps the books.', template_id: 'bookkeeper', provider: 'p', model: 'm' },
    briefing: 'Seed facts.',
    ...over
  }
}

async function codeOf(promise: Promise<unknown>): Promise<[number | undefined, unknown]> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e
  )
  if (!isGatewayError(err)) {
    throw new Error('expected a GatewayError')
  }
  return [err.status, err.code]
}

function setup() {
  const profiles = new Set(['default', 'thijs'])
  const now = { value: Date.parse('2026-09-25T10:00:00Z') }
  const ergates = new FakeErgates({ hasProfile: name => profiles.has(name), now: () => now.value })
  return { ergates, profiles, now }
}

describe('FakeErgates reminders', () => {
  it('creates once, returns the same receipt for the same request, and conflicts on another payload', async () => {
    const { ergates } = setup()

    const created = await ergates.createReminder(request())
    expect(created.status).toBe('created')
    expect(created.receipt).toMatchObject({ id: 'rem-1', request_id: 'rem-1', state: 'created', timezone_advisory: 'Europe/Amsterdam' })
    await expect(ergates.createReminder(request())).resolves.toEqual({ status: 'existing', receipt: created.receipt })
    await expect(ergates.createReminder(request({ prompt: 'Something else.' }))).resolves.toMatchObject({ status: 'conflict', receipt: { id: 'rem-1' } })
    expect(ergates.jobs).toHaveLength(1)
    expect(ergates.jobs[0]!.name).toMatch(/^\[bot:thijs\] Invoices · [0-9a-f]{8}$/)
  })

  it('treats request ids as global across profiles', async () => {
    const { ergates, profiles } = setup()
    profiles.add('anna')
    await ergates.createReminder(request())

    await expect(ergates.createReminder(request({ profile: 'anna' }))).resolves.toMatchObject({ status: 'conflict' })
  })

  it('answers an uncertain create, and reconciles it on a deliberate resend', async () => {
    const { ergates } = setup()
    ergates.nextCreateUncertain({ jobCreated: true })

    const first = await ergates.createReminder(request())
    expect(first).toMatchObject({ status: 'uncertain', receipt: { state: 'uncertain', job_id: null } })
    await expect(ergates.createReminder(request())).resolves.toMatchObject({ status: 'existing', receipt: { state: 'created' } })
    expect(ergates.jobs).toHaveLength(1)
  })

  it.each([
    [{ label: 'x'.repeat(65) }],
    [{ label: 'two\nlines' }],
    [{ label: '' }],
    [{ request_id: 'has spaces' }],
    [{ request_id: '' }],
    [{ timezone: 'Mars/Olympus' }],
    [{ schedule: ' ' }],
    [{ profile: 'Thijs' }],
    [{ schedule: 'not a schedule' }]
  ])('refuses %j with 400 invalid and creates nothing', async over => {
    const { ergates } = setup()

    await expect(codeOf(ergates.createReminder(request(over)))).resolves.toEqual([400, 'invalid'])
    expect(ergates.jobs).toEqual([])
  })

  it('refuses an unknown profile with 404 unknown_profile', async () => {
    const { ergates } = setup()

    await expect(codeOf(ergates.createReminder(request({ profile: 'nora' })))).resolves.toEqual([404, 'unknown_profile'])
  })

  it('names a job without a label "reminder", never after the prompt', async () => {
    const { ergates } = setup()

    await ergates.createReminder(request({ label: undefined }))
    expect(ergates.jobs[0]!.name).toMatch(/^\[bot:thijs\] reminder · [0-9a-f]{8}$/)
  })
})

describe('FakeErgates proposals', () => {
  it('accepts with the template, answers null templates elsewhere, and runs the steps in order', async () => {
    const { ergates, profiles } = setup()
    const proposal = proposalFor('pim')
    ergates.record(proposal)

    expect(await ergates.getProposal('p-pim')).toMatchObject({ state: 'proposed', template: null, next_step: 'profile_created' })
    const accepted = await ergates.acceptProposal('p-pim', proposal)
    expect(accepted).toMatchObject({ state: 'accepted', template: PROPOSAL_TEMPLATE, reserved_profile_name: 'pim' })
    expect((await ergates.acceptProposal('p-pim', proposal)).template).toEqual(PROPOSAL_TEMPLATE)

    await expect(codeOf(ergates.recordProposalStep('p-pim', 'configured', 'done'))).resolves.toEqual([409, 'out_of_order'])
    profiles.add('pim')
    await ergates.recordProposalStep('p-pim', 'profile_created', 'done')
    await ergates.enablePlugin('pim')
    for (const step of ['plugin_enabled', 'configured', 'bot_chat'] as const) {
      expect((await ergates.recordProposalStep('p-pim', step, 'done')).template).toBeNull()
    }
    const complete = await ergates.recordProposalStep('p-pim', 'briefing', 'done')
    expect(complete).toMatchObject({ state: 'complete', next_step: null, completed_steps: ['profile_created', 'plugin_enabled', 'configured', 'bot_chat', 'briefing'] })
  })

  it('keeps an uncertain step without advancing', async () => {
    const { ergates } = setup()
    ergates.record(proposalFor('pim'))
    await ergates.acceptProposal('p-pim', proposalFor('pim'))

    const receipt = await ergates.recordProposalStep('p-pim', 'profile_created', 'uncertain')
    expect(receipt).toMatchObject({ step_status: { profile_created: 'uncertain' }, next_step: 'profile_created' })
  })

  it('answers not_ready for the briefing until the profile has the plugin, keeping the step', async () => {
    const { ergates, profiles } = setup()
    ergates.record(proposalFor('pim'))
    await ergates.acceptProposal('p-pim', proposalFor('pim'))
    profiles.add('pim')
    for (const step of ['profile_created', 'plugin_enabled', 'configured', 'bot_chat'] as const) {
      await ergates.recordProposalStep('p-pim', step, 'done')
    }

    await expect(codeOf(ergates.recordProposalStep('p-pim', 'briefing', 'done'))).resolves.toEqual([409, 'not_ready'])
    expect(await ergates.getProposal('p-pim')).toMatchObject({ state: 'accepted', step_status: { briefing: 'done' }, next_step: null })
    await ergates.enablePlugin('pim')
    expect((await ergates.recordProposalStep('p-pim', 'briefing', 'done')).state).toBe('complete')
  })

  it('refuses what the server refuses', async () => {
    const { ergates, now } = setup()
    ergates.record(proposalFor('pim'))
    ergates.record(proposalFor('thijs'))
    ergates.record(proposalFor('anna', { agent: { ...proposalFor('anna').agent, template_id: 'auditor' } }))
    ergates.record(proposalFor('bob'))

    await expect(codeOf(ergates.getProposal('nope'))).resolves.toEqual([404, 'not_found'])
    await expect(codeOf(ergates.acceptProposal('p-pim', { ...proposalFor('pim'), briefing: 'Other.' }))).resolves.toEqual([409, 'hash_mismatch'])
    await expect(codeOf(ergates.acceptProposal('p-thijs', proposalFor('thijs')))).resolves.toEqual([409, 'name_taken'])
    await expect(codeOf(ergates.acceptProposal('p-anna', proposalFor('anna', { agent: { ...proposalFor('anna').agent, template_id: 'auditor' } })))).resolves.toEqual([422, 'unknown_template'])
    expect((await ergates.getProposal('p-anna')).state).toBe('proposed')
    await ergates.rejectProposal('p-bob')
    await expect(codeOf(ergates.acceptProposal('p-bob', proposalFor('bob')))).resolves.toEqual([409, 'not_acceptable'])
    await ergates.acceptProposal('p-pim', proposalFor('pim'))
    await expect(codeOf(ergates.rejectProposal('p-pim'))).resolves.toEqual([409, 'not_acceptable'])
    now.value = Date.parse('2026-09-26T10:00:01Z')
    ergates.record(proposalFor('cleo'))
    await expect(codeOf(ergates.acceptProposal('p-cleo', proposalFor('cleo')))).resolves.toEqual([410, 'expired'])
    expect((await ergates.getProposal('p-cleo')).state).toBe('expired')
  })

  it('enables the plugin only in a profile that exists', async () => {
    const { ergates } = setup()

    await expect(ergates.enablePlugin('thijs')).resolves.toEqual({ profile: 'thijs', enabled: true })
    await expect(codeOf(ergates.enablePlugin('nora'))).resolves.toEqual([404, 'unknown_profile'])
  })
})

describe('FakeErgates attention prefs', () => {
  it('falls back from the profile to the "*" row to the defaults', async () => {
    const { ergates } = setup()

    expect(await ergates.attentionPrefs('thijs')).toEqual({ profile: 'thijs', muted: false, quiet_start: null, quiet_end: null })
    await ergates.setAttentionPrefs({ profile: '*', muted: false, quiet_start: '22:00', quiet_end: '07:00' })
    expect(await ergates.attentionPrefs('thijs')).toEqual({ profile: 'thijs', muted: false, quiet_start: '22:00', quiet_end: '07:00' })
    await ergates.setAttentionPrefs({ profile: 'thijs', muted: true, quiet_start: null, quiet_end: null })
    expect(await ergates.attentionPrefs('thijs')).toEqual({ profile: 'thijs', muted: true, quiet_start: null, quiet_end: null })
  })

  it.each([
    [{ profile: 'thijs', muted: false, quiet_start: '25:00', quiet_end: '07:00' }],
    [{ profile: 'thijs', muted: false, quiet_start: '22:00', quiet_end: null }],
    [{ profile: 'thijs', muted: false, quiet_start: '07:00', quiet_end: '07:00' }],
    [{ profile: 'Bad Name', muted: false, quiet_start: null, quiet_end: null }]
  ])('refuses %j with 400 invalid', async prefs => {
    const { ergates } = setup()

    await expect(codeOf(ergates.setAttentionPrefs(prefs))).resolves.toEqual([400, 'invalid'])
  })
})

describe('FakeErgates faults', () => {
  it('fails the next call of one route before or after it takes effect', async () => {
    const { ergates } = setup()
    ergates.record(proposalFor('pim'))
    ergates.fail('acceptProposal', new GatewayError('timeout', 'The gateway did not answer in time.'), 'after')

    await expect(ergates.acceptProposal('p-pim', proposalFor('pim'))).rejects.toMatchObject({ kind: 'timeout' })
    expect((await ergates.getProposal('p-pim')).state).toBe('accepted')
    expect(ergates.calls.map(c => c.op)).toEqual(['acceptProposal', 'getProposal'])
  })

  it('fails the next call with the server\'s generic 500 internal error', async () => {
    const { ergates } = setup()
    ergates.record(proposalFor('pim'))
    ergates.failInternal('getProposal')

    await expect(codeOf(ergates.getProposal('p-pim'))).resolves.toEqual([500, 'internal'])
  })
})

describe('FakeErgates health and setup', () => {
  const unfinished: SetupState = { finished: false, templates: 'installed', profiles: [{ name: 'default', enabled: false }] }

  it('answers a healthy, fully set up plugin until told otherwise', async () => {
    const { ergates } = setup()

    const probe = await ergates.health()
    expect(probe).toMatchObject({ state: 'answered', health: { ok: true, setup: { finished: true } } })
    expect(await ergates.health()).toEqual(probe)
  })

  it('reports the commit it was installed and loaded from as one, until told otherwise', async () => {
    const { ergates } = setup()

    await expect(ergates.health()).resolves.toMatchObject({
      health: { install: { kind: 'git install', commit: FAKE_PLUGIN_COMMIT, loaded_commit: FAKE_PLUGIN_COMMIT } }
    })
  })

  it('follows the installed commit it is given at every call, while the loaded commit stays', async () => {
    const record = { commit: FAKE_PLUGIN_COMMIT as string | null }
    const ergates = new FakeErgates({ hasProfile: () => true, installedCommit: () => record.commit })

    record.commit = 'b'.repeat(40)
    await expect(ergates.health()).resolves.toMatchObject({ health: { install: { commit: 'b'.repeat(40), loaded_commit: FAKE_PLUGIN_COMMIT } } })
    ergates.loadedCommit = 'b'.repeat(40)
    await expect(ergates.health()).resolves.toMatchObject({ health: { install: { commit: 'b'.repeat(40), loaded_commit: 'b'.repeat(40) } } })
  })

  it('answers absent, while it is told Hermes does not serve the plugin, until a test sets its own health', async () => {
    const served = { now: false }
    const ergates = new FakeErgates({ hasProfile: () => true, pluginServed: () => served.now })

    await expect(ergates.health()).resolves.toEqual({ state: 'absent' })
    served.now = true
    await expect(ergates.health()).resolves.toMatchObject({ state: 'answered' })
    served.now = false
    ergates.setHealth({ state: 'not_loaded' })
    await expect(ergates.health()).resolves.toEqual({ state: 'not_loaded' })
  })

  it('keeps whatever health a test sets, whatever the commits say', async () => {
    const ergates = new FakeErgates({ hasProfile: () => true, installedCommit: () => 'b'.repeat(40) })
    const probe = { state: 'answered', health: { ok: true, plugin_version: '0.2.0', schema_version: 1 } } as const
    ergates.setHealth(probe)

    await expect(ergates.health()).resolves.toEqual(probe)
  })

  it.each([{ state: 'absent' }, { state: 'not_loaded' }] as const)('answers the probe it is set to: %j', async probe => {
    const { ergates } = setup()
    ergates.setHealth(probe)

    await expect(ergates.health()).resolves.toEqual(probe)
    await expect(ergates.health()).resolves.toEqual(probe)
  })

  it('rejects when set to an error, as a real 503 from the plugin does', async () => {
    const { ergates } = setup()
    ergates.setHealth(mapErgatesError(503, { error: { code: 'store_unavailable', message: 'the Ergates control store is unavailable' } }))

    await expect(codeOf(ergates.health())).resolves.toEqual([503, 'store_unavailable'])
  })

  it('reads the probe from a function at every call, so a test can follow other state', async () => {
    const { ergates } = setup()
    let installed = false
    ergates.setHealth(() => (installed ? { state: 'answered', health: { ok: true, plugin_version: '0.2.0', schema_version: 1 } } : { state: 'absent' }))

    await expect(ergates.health()).resolves.toEqual({ state: 'absent' })
    installed = true
    await expect(ergates.health()).resolves.toMatchObject({ state: 'answered' })
  })

  it('hands out a copy of the probe, so a caller cannot change the fake', async () => {
    const { ergates } = setup()
    const probe = await ergates.health()
    if (probe.state === 'answered') {
      probe.health.ok = false
    }

    await expect(ergates.health()).resolves.toMatchObject({ health: { ok: true } })
  })

  it('counts every setup call and answers the result it is set to', async () => {
    const { ergates } = setup()
    expect(ergates.setupCalls).toBe(0)

    await expect(ergates.setup()).resolves.toMatchObject({ finished: true, templates: 'installed' })
    ergates.setSetupResult(unfinished)
    await expect(ergates.setup()).resolves.toEqual(unfinished)
    expect(ergates.setupCalls).toBe(2)
  })

  it('fails the next setup call like any other route', async () => {
    const { ergates } = setup()
    ergates.fail('setup', new GatewayError('network', 'No connection to the gateway.'))

    await expect(ergates.setup()).rejects.toMatchObject({ kind: 'network' })
    await expect(ergates.setup()).resolves.toMatchObject({ finished: true })
    expect(ergates.setupCalls).toBe(2)
  })
})
