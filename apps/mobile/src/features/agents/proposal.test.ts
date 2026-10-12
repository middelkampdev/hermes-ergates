/**
 * Which proposals a chat shows, and what each card says and offers
 * (docs/11 section 4.1). Pure: the card and its hook only render this.
 */
import { describe, expect, it } from 'vitest'

import { GatewayError } from '@/gateway/errors'
import type { AgentProposal, ProposalReceipt } from '@/gateway/types'

import { collectProposals, proposalView, shouldForgetRun, PROPOSE_TOOL, type ProposalViewInput } from './proposal'

const proposal = (id: string, name = 'pim'): AgentProposal => ({
  kind: 'ergates.agent-proposal.v1',
  proposal_id: id,
  expires_at: '2999-01-01T00:00:00Z',
  source_session_id: 'concierge-1',
  agent: { name, title: 'Pim', role: 'Bookkeeper', description: 'Keeps the books.', template_id: 'bookkeeper', provider: 'p', model: 'm' },
  briefing: 'Seed facts.'
})

const receipt = (state: ProposalReceipt['state'], over: Partial<ProposalReceipt> = {}): ProposalReceipt => ({
  proposal_id: 'p-1',
  state,
  reserved_profile_name: 'pim',
  expires_at: '2999-01-01T00:00:00Z',
  completed_steps: [],
  step_status: {},
  next_step: 'profile_created',
  template: null,
  ...over
})

const input = (over: Partial<ProposalViewInput>): ProposalViewInput => ({
  proposal: proposal('p-1'),
  receipt: undefined,
  receiptError: null,
  step: null,
  outcome: null,
  busy: false,
  notice: null,
  ...over
})

describe('collectProposals', () => {
  it('reads the tool results of the transcript, the live chat and the stored setups, once each', () => {
    const rows = [
      { role: 'tool', toolName: PROPOSE_TOOL, result: proposal('p-1') },
      { role: 'tool', toolName: 'terminal', result: proposal('p-x') },
      { role: 'assistant', result: proposal('p-y') }
    ]
    const items = [
      { kind: 'tool', name: PROPOSE_TOOL, result: proposal('p-1') },
      { kind: 'tool', name: PROPOSE_TOOL, result: { error: 'name must match ^[a-z0-9][a-z0-9-]{1,31}$' } },
      { kind: 'tool', name: PROPOSE_TOOL, result: proposal('p-2', 'anna') },
      { kind: 'assistant', result: proposal('p-z') }
    ]
    const stored = [proposal('p-3', 'bob'), { not: 'a proposal' }]

    expect(collectProposals(items, rows, stored).map(p => p.proposal_id)).toEqual(['p-1', 'p-2', 'p-3'])
  })
})

describe('proposalView', () => {
  it('offers accept and reject for a proposed agent', () => {
    expect(proposalView(input({ receipt: receipt('proposed') }))).toEqual({ hidden: false, status: 'proposed', text: null, actions: ['accept', 'reject'] })
  })

  it('shows the running step with its place in the setup', () => {
    expect(proposalView(input({ receipt: receipt('accepted'), step: 'configured' }))).toMatchObject({ status: 'working', text: 'Setting up Pim: applying its role (3 of 5).', actions: [] })
  })

  it('hides a proposal that ended before this screen opened', () => {
    for (const state of ['rejected', 'expired', 'complete'] as const) {
      expect(proposalView(input({ receipt: receipt(state) })).hidden).toBe(true)
    }
    const pruned = new GatewayError('not_found', 'no proposal', { status: 404, code: 'not_found' })
    expect(proposalView(input({ receiptError: pruned })).hidden).toBe(true)
  })

  describe('when the gateway has no Ergates route', () => {
    const missing = new GatewayError('not_found', 'Not Found', { status: 404 })

    it('says what the server check found and offers its action', () => {
      const notice = { text: 'The Ergates plugin is turned off on this server.', action: { label: 'Turn on', route: '/server' } } as const
      expect(proposalView(input({ receiptError: missing, notice }))).toEqual({ hidden: false, status: 'closed', text: notice.text, actions: ['server_setup'] })
    })

    it('offers nothing to tap for a notice without an action', () => {
      const notice = { text: "This server's Ergates plugin needs a newer version of this app. Update Ergates.", action: null }
      expect(proposalView(input({ receiptError: missing, notice }))).toEqual({ hidden: false, status: 'closed', text: notice.text, actions: [] })
    })

    it('says the plugin is not set up while the server check has no notice', () => {
      expect(proposalView(input({ receiptError: missing, notice: null }))).toEqual({ hidden: false, status: 'closed', text: 'Ergates is not set up on this server.', actions: [] })
    })

    it('keeps its Ergates not_found hidden, whatever the notice says', () => {
      const pruned = new GatewayError('not_found', 'no proposal', { status: 404, code: 'not_found' })
      const notice = { text: 'Ergates is not set up on this server.', action: { label: 'Set up', route: '/server' } } as const
      expect(proposalView(input({ receiptError: pruned, notice })).hidden).toBe(true)
    })
  })

  it('reports each outcome of a run with the action it allows', () => {
    expect(proposalView(input({ outcome: { kind: 'complete', profile: 'pim' } }))).toMatchObject({ status: 'complete', text: 'Pim is ready.', actions: ['open_chat'] })
    expect(proposalView(input({ outcome: { kind: 'confirm_briefing', profile: 'pim' } }))).toMatchObject({ status: 'confirm', actions: ['open_chat', 'resend_briefing'] })
    expect(proposalView(input({ outcome: { kind: 'not_ready', profile: 'pim' } }))).toMatchObject({ status: 'waiting', actions: ['retry'] })
    expect(proposalView(input({ outcome: { kind: 'failed', step: 'configured', message: 'Hermes did not apply: toolsets.', terminal: false } }))).toMatchObject({
      status: 'failed',
      text: 'Applying its role failed. Hermes did not apply: toolsets.',
      actions: ['retry']
    })
    expect(proposalView(input({ outcome: { kind: 'failed', step: 'accept', message: 'This proposal expired. Ask the agent to propose it again.', terminal: true } }))).toMatchObject({
      status: 'closed',
      actions: []
    })
  })

  it('lets a failed receipt read be tried again', () => {
    const offline = new GatewayError('network', 'No connection to the gateway.')
    expect(proposalView(input({ receiptError: offline }))).toMatchObject({ status: 'failed', text: 'No connection to the gateway.', actions: ['reload'] })
  })

  it('offers reject too when a non-terminal accept failure leaves the receipt proposed', () => {
    const failedAccept = { kind: 'failed', step: 'accept', message: 'No connection to the gateway.', terminal: false } as const
    expect(proposalView(input({ receipt: receipt('proposed'), outcome: failedAccept }))).toMatchObject({ status: 'failed', actions: ['retry', 'reject'] })
    // No receipt yet, or a receipt no longer proposed: only retry, as before.
    expect(proposalView(input({ outcome: failedAccept }))).toMatchObject({ status: 'failed', actions: ['retry'] })
    expect(proposalView(input({ receipt: receipt('accepted'), outcome: failedAccept }))).toMatchObject({ status: 'failed', actions: ['retry'] })
  })

  it('offers only retry for a later-step failure, even while a stale cached receipt still reads proposed', () => {
    const failedCreate = { kind: 'failed', step: 'profile_created', message: 'No connection to the gateway.', terminal: false } as const
    expect(proposalView(input({ receipt: receipt('proposed'), outcome: failedCreate }))).toMatchObject({ status: 'failed', actions: ['retry'] })
  })

  it('lets a settled receipt win over a non-final failure of an earlier run', () => {
    // Accept failed offline, then the user rejected: the card must not keep
    // offering "Try again" for an accept the server now refuses.
    const failedAccept = { kind: 'failed', step: 'accept', message: 'No connection to the gateway.', terminal: false } as const
    for (const state of ['rejected', 'expired', 'complete'] as const) {
      expect(proposalView(input({ receipt: receipt(state), outcome: failedAccept }))).toEqual({ hidden: true, status: 'closed', text: null, actions: [] })
    }
    const failedStep = { kind: 'failed', step: 'configured', message: 'Hermes did not apply: toolsets.', terminal: false } as const
    expect(proposalView(input({ receipt: receipt('complete'), outcome: failedStep })).hidden).toBe(true)
    // A run on this screen that ended on its own terms still reports itself.
    expect(proposalView(input({ receipt: receipt('complete'), outcome: { kind: 'complete', profile: 'pim' } }))).toMatchObject({ status: 'complete', actions: ['open_chat'] })
    const refused = { kind: 'failed', step: 'accept', message: 'This proposal expired. Ask the agent to propose it again.', terminal: true } as const
    expect(proposalView(input({ receipt: receipt('expired'), outcome: refused }))).toMatchObject({ status: 'closed', text: refused.message })
  })

  it('shows an accepted proposal as being set up until the run reports a step', () => {
    expect(proposalView(input({ receipt: receipt('accepted') }))).toMatchObject({ status: 'working', text: 'Setting up Pim…', actions: [] })
    expect(proposalView(input({ receipt: receipt('proposed'), busy: true }))).toMatchObject({ status: 'working', actions: [] })
    expect(proposalView(input({}))).toMatchObject({ status: 'loading', actions: [] })
  })
})

describe('shouldForgetRun', () => {
  it('is true once the receipt settled where no further run can help', () => {
    for (const state of ['complete', 'expired', 'rejected'] as const) {
      expect(shouldForgetRun(receipt(state), null)).toBe(true)
    }
    expect(shouldForgetRun(receipt('proposed'), null)).toBe(false)
    expect(shouldForgetRun(receipt('accepted'), null)).toBe(false)
  })

  it('is true once the server has pruned the receipt entirely', () => {
    const pruned = new GatewayError('not_found', 'no proposal', { status: 404, code: 'not_found' })
    expect(shouldForgetRun(undefined, pruned)).toBe(true)
  })

  it('is false for a read that failed for a reason that says nothing about the proposal, or one not yet answered', () => {
    const missingPlugin = new GatewayError('not_found', 'Not Found', { status: 404 })
    const offline = new GatewayError('network', 'No connection to the gateway.')
    expect(shouldForgetRun(undefined, missingPlugin)).toBe(false)
    expect(shouldForgetRun(undefined, offline)).toBe(false)
    expect(shouldForgetRun(undefined, null)).toBe(false)
  })
})
