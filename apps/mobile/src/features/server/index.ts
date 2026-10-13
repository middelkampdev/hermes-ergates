/** Public API of the server feature (ADR-029): screens, UI and other features import only this file. */
export { afterSignIn, routeAfterCheck, type SetupRoute } from './after-sign-in'
export { PLUGIN_IDENTIFIER, PLUGIN_NAME, parseBuildRecord, type BuildRecord, type HermesRange, type RequiredPlugin } from './build-record'
export { externalPath } from './external-link'
export {
  finishUpdateOf,
  finishVariant,
  finishView,
  goBackTarget,
  highestSchema,
  NO_UPDATE,
  pendingCommit,
  RESTART_HEADING,
  runIsGoing,
  SERVER_GUIDE_URL,
  setupProblem,
  SIGNED_OUT_HINT,
  updateStillOpen,
  type FinishAction,
  type FinishManual,
  type FinishUpdate,
  type FinishVariant,
  type FinishView,
  type SetupProgress
} from './finish-view'
export { hermesFit, parseHermesVersion, type HermesFit } from './hermes-version'
export { clearPendingSetup, finishPendingSetup, markPendingSetup, runningKind, type RunKind } from './pending-setup'
export { MISSING_NOTICE, noticeForError, pluginNotice, pluginRowSubtitle, updateLine, type NoticeRoute, type PluginNotice } from './plugin-notice'
export { AUTO_UPDATE_LABEL, autoUpdate, type UpdateOffer } from './plugin-version'
export { checkServer, isSignedOut, pluginFits, type InstallKind, type PluginFit, type ServerCheck } from './server-check'
export { isSetupRunning, lastManualOutcome, runSetup, type ManualFailure, type ManualOutcome, type SetupDeps, type SetupOutcome, type SetupStep, type StepStatus } from './setup-run'
export { SETUP_TITLE, opensFinish, setupScreenView, setupView, stepStatusWord, type HeldCheck, type SetupAction, type SetupRunState, type SetupView } from './setup-view'
export { lastUpdateOutcome, runUpdate, type UpdateDeps, type UpdateOutcome, type UpdateStep } from './update-run'
export { joinTarget, offerOf, PENDING_UPDATE_RUN, targetOf, updateScreenView, updateSteps, updateView, type UpdateAction, type UpdateRunState, type UpdateTarget, type UpdateView } from './update-view'
export { usePluginNotice } from './use-plugin-notice'
export { serverCheckKey, useServerCheck } from './use-server-check'
