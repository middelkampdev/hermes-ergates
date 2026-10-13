/** Public API of the server feature (ADR-029): screens, UI and other features import only this file. */
export { afterSignIn, routeAfterCheck, type SetupRoute } from './after-sign-in'
export { PLUGIN_IDENTIFIER, PLUGIN_NAME, parseBuildRecord, type BuildRecord, type HermesRange, type RequiredPlugin } from './build-record'
export { externalPath } from './external-link'
export {
  finishVariant,
  finishView,
  pendingCommit,
  RESTART_HEADING,
  SERVER_GUIDE_URL,
  setupProblem,
  SIGNED_OUT_HINT,
  type FinishAction,
  type FinishManual,
  type FinishVariant,
  type FinishView,
  type SetupProgress
} from './finish-view'
export { hermesFit, parseHermesVersion, type HermesFit } from './hermes-version'
export { clearPendingSetup, finishPendingSetup, markPendingSetup } from './pending-setup'
export { MISSING_NOTICE, noticeForError, pluginNotice, pluginRowSubtitle, updateLine, type NoticeRoute, type PluginNotice } from './plugin-notice'
export { autoUpdate, type UpdateOffer } from './plugin-version'
export { checkServer, isSignedOut, pluginFits, type InstallKind, type PluginFit, type ServerCheck } from './server-check'
export { isSetupRunning, lastManualOutcome, runSetup, type ManualFailure, type ManualOutcome, type SetupDeps, type SetupOutcome, type SetupStep, type StepStatus } from './setup-run'
export { SETUP_TITLE, opensFinish, setupScreenView, setupView, stepStatusWord, type HeldCheck, type SetupAction, type SetupRunState, type SetupView } from './setup-view'
export { lastUpdateOutcome, runUpdate, type UpdateDeps, type UpdateOutcome, type UpdateStep } from './update-run'
export { usePluginNotice } from './use-plugin-notice'
export { serverCheckKey, useServerCheck } from './use-server-check'
