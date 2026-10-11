/** Public API of the agents feature (ADR-029): screens, UI and other features import only this file. */
export { createAgent, slugFromTitle, validateCreate } from './create'
export { deleteAgent } from './delete'
export {
  NO_SELECTION,
  buildEditItems,
  collapseSelection,
  editBarLabels,
  editRowLabel,
  hideEach,
  hideFailureMessage,
  listItems,
  liveSelection,
  moveActions,
  moveDirection,
  moveStep,
  pinnedItems,
  selectedInListOrder,
  selectionTitle,
  toggleSelected,
  type EditBarLabels,
  type EditItem,
  type EditLayout,
  type ListItem,
  type MoveAction,
  type MoveDirection,
  type PinnedItem,
  type Selection
} from './edit-mode'
export { EDIT_SECTION_ACTION, canSaveSectionName, deleteSectionPrompt, shownSectionName, type DeletePrompt } from './section-page'
export {
  EDIT_ITEM_HEIGHT,
  NO_SECTION_DRAG,
  crossDrop,
  crossMove,
  crossSlot,
  dropMove,
  listMinHeight,
  nextOrder,
  nextSectionDrag,
  pageRect,
  pinDropMove,
  returnToStart,
  sameSlot,
  sectionDragItems,
  slotMeta,
  sortableChildKey,
  visibleArea,
  withSectionGhosts,
  type CrossSlot,
  type DragItem,
  type Point,
  type Rect,
  type SectionDrag,
  type SectionDragEvent,
  type SlotMeta
} from './drop-rules'
export {
  autoScrollOffset,
  autoScrollSpeed,
  lineAt,
  lineTop,
  pinAt,
  pinCells,
  swipeLines,
  swipeMode,
  swipeSelection,
  type PinAreaLayout,
  type PinCell,
  type SwipeLine,
  type SwipeMode
} from './swipe-select'
export {
  canCreateSection,
  membershipChanged,
  membershipSnapshot,
  newSection,
  parseProfiles,
  profilesParam,
  sectionChoices,
  type MembershipSnapshot,
  type SectionChoice
} from './move-to-section'
export { collectProposals, parseAgentProposal, proposalView, shouldForgetRun, PROPOSAL_KIND, PROPOSE_TOOL, type ProposalAction, type ProposalView } from './proposal'
export { provisionAgent, provisionDeps, provisionOnce, type OpenBotChat, type ProvisionDeps, type ProvisionOptions, type ProvisionOutcome } from './provision'
export { AVATAR_MAX_BYTES, botsMeta, instructionsSummary, modelSummary, type SaveOutcome, type SaveSection } from './editor'
export { EditBotProvider, useEditBotContext } from './editor-context'
export { rosterKey, searchBots, useAvatar, useDescribe, useModelOptions, useRoster, useSetHidden, type Bot } from './roster'
export { homeErrorLine, type HomeErrorLine } from './home-error'
export { useHome, useOrganizer } from './use-home'
export { useOrgSync } from './use-org-sync'
