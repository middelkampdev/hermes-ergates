/**
 * useProposals and useProposal: the React binding of the agent proposal cards
 * (docs/11 section 4.1). The rules live in `@/features/agents`
 * (`collectProposals`, `proposalView`, `provisionAgent`), pure and tested in
 * Node; this file holds the Query, the device-store setup run and the one
 * automatic resume per card mount (ADR-029 rule 2).
 */

import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { collectProposals, proposalView, provisionAgent, provisionDeps, provisionOnce, rosterKey, shouldForgetRun, type ProposalView, type ProvisionOutcome } from '@/features/agents'
import type { PluginNotice } from '@/features/server'
import type { AgentProposal, ProvisionStep } from '@/gateway/types'
import { useDeviceStore } from '@/state/device-store'
import { withStartedAt } from '@/state/provisioning'

import { openCanonicalChat } from './canonical-chat'
import { useChatSession } from './chat-session-context'

export const proposalKey = (connectionId: string, proposalId: string) => ['proposal', connectionId, proposalId] as const

export interface ProposalCardState {
  view: ProposalView
  accept(): Promise<void>
  /** Rejects when the server refuses; the card shows why. */
  reject(): Promise<void>
  retry(): Promise<void>
  resendBriefing(): Promise<void>
  reload(): void
}

/** The proposals this chat shows: its tool results, and this device's unfinished setups started here. */
export function useProposals(): AgentProposal[] {
  const { connectionId, profile, session, transcript } = useChatSession()
  const runs = useDeviceStore(s => s.provisioning)
  const items = session.state.items
  const rows = transcript.window.rows
  return useMemo(() => {
    const stored = runs.filter(run => run.connectionId === connectionId && run.sourceProfile === profile).map(run => run.proposal)
    return collectProposals(items, rows, stored)
  }, [runs, connectionId, profile, items, rows])
}

/** `notice` is what the server check says about the plugin; the card shows it when the proposal route is missing. */
export function useProposal(proposal: AgentProposal, notice: PluginNotice | null): ProposalCardState {
  const { connectionId, profile, port } = useChatSession()
  const client = useQueryClient()
  const id = proposal.proposal_id
  const receipt = useQuery({ queryKey: proposalKey(connectionId, id), queryFn: () => port.ergates.getProposal(id), retry: false, staleTime: 5_000 })
  const saveRun = useDeviceStore(s => s.saveProvisioningRun)
  const removeRun = useDeviceStore(s => s.removeProvisioningRun)
  const [step, setStep] = useState<ProvisionStep | null>(null)
  const [outcome, setOutcome] = useState<ProvisionOutcome | null>(null)
  const [busy, setBusy] = useState(false)

  // Reopening resumes: an accepted proposal whose setup did not finish runs
  // again, once per mount. Set at the top of `run`, not only by the resume
  // effect below, so a deliberate tap (Accept, Try again, ...) also uses up
  // the one automatic run — otherwise a tapped run that ends non-terminally
  // (still `accepted` on the server) would refetch, see the effect's guard
  // still open, and restart itself with no tap, replacing "Try again" with a
  // silent retry (ADR-027 keeps retries an explicit tap).
  const resumed = useRef(false)

  const run = useCallback(
    async (resendBriefing: boolean) => {
      resumed.current = true
      setBusy(true)
      setOutcome(null)
      // Saved before the accept call: only the tool result carries the
      // payload and the briefing. Keeps this proposal's existing startedAt
      // when it already has a stored run, so a retry or a resume does not
      // look freshly started.
      const existing = useDeviceStore.getState().provisioning.find(r => r.proposalId === id)
      saveRun(withStartedAt(existing, { proposalId: id, connectionId, sourceProfile: profile, proposal: proposal as unknown as Record<string, unknown> }, Date.now()))
      const result = await provisionOnce(id, () => provisionAgent(provisionDeps(port, openCanonicalChat), proposal, { resendBriefing, onStep: setStep }))
      setStep(null)
      setBusy(false)
      setOutcome(result)
      if (result.kind === 'complete' || (result.kind === 'failed' && result.terminal)) {
        removeRun(id)
      }
      if (result.kind === 'complete') {
        void client.invalidateQueries({ queryKey: rosterKey(connectionId) })
      }
      void client.invalidateQueries({ queryKey: proposalKey(connectionId, id) })
    },
    [client, connectionId, id, port, profile, proposal, removeRun, saveRun]
  )

  const state = receipt.data?.state
  useEffect(() => {
    if (state === 'accepted' && !resumed.current) {
      void run(false)
    }
  }, [state, run])

  // Forget a stored run this screen never has to act on again: the server
  // already settled the proposal terminally (this device may not have been
  // the one that noticed) or has pruned the receipt. Only once no run of
  // this hook's own is in flight, so a run in progress is never raced.
  const receiptData = receipt.data
  const receiptErr = receipt.error
  useEffect(() => {
    if (!busy && shouldForgetRun(receiptData, receiptErr)) {
      removeRun(id)
    }
  }, [receiptData, receiptErr, busy, removeRun, id])

  const reject = useCallback(async () => {
    setBusy(true)
    try {
      const settled = await port.ergates.rejectProposal(id)
      // The reject landed: an earlier failed accept is over, and the card
      // shows the server's answer at once, not a stale `proposed` read.
      setOutcome(null)
      client.setQueryData(proposalKey(connectionId, id), settled)
      removeRun(id)
    } finally {
      setBusy(false)
      void client.invalidateQueries({ queryKey: proposalKey(connectionId, id) })
    }
  }, [client, connectionId, id, port, removeRun])

  const refetch = receipt.refetch
  return {
    view: proposalView({ proposal, receipt: receipt.data, receiptError: receipt.error, step, outcome, busy, notice }),
    accept: () => run(false),
    reject,
    retry: () => run(false),
    resendBriefing: () => run(true),
    reload: () => void refetch()
  }
}
