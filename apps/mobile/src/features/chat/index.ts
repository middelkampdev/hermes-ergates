/** Public API of the chat feature (ADR-029): screens, UI and other features import only this file. */
export { peerKey } from './agent-traffic/peers'
export { exchangeTranscript, type ActivityEntry, type Line, type TranscriptEntry } from './agent-traffic/timeline'
export type { PeerRef } from './agent-traffic/types'
export { useExchangeAcknowledgement } from './agent-traffic/use-exchange-acknowledgement'
export { ChatSessionProvider, useChatSession } from './chat-session-context'
export { devInjectFrames } from './dev-inject'
export type { ChatItem } from './history'
export { useProposal, useProposals, type ProposalCardState, type ProposalServer } from './use-proposal'
