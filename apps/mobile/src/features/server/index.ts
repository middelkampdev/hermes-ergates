/** Public API of the server feature (ADR-029): screens, UI and other features import only this file. */
export { afterSignIn, type SetupRoute } from './after-sign-in'
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
export { MISSING_NOTICE, noticeForError, pluginNotice, pluginRowSubtitle, shouldReloadAfterNotice, type NoticeRoute, type PluginNotice } from './plugin-notice'
export { AUTO_UPDATE_LABEL, autoUpdate, type UpdateOffer } from './plugin-version'
export { checkServer, isSignedOut, pluginFits, type InstallKind, type PluginFit, type ServerCheck } from './server-check'
export { isSetupRunning, joinSetup, lastManualOutcome, runSetup, type ManualFailure, type ManualOutcome, type SetupDeps, type SetupOutcome, type SetupStep, type StepStatus } from './setup-run'
export { SETUP_TITLE, opensFinish, setupRedirect, setupScreenView, setupView, stepStatusWord, type HeldCheck, type SetupAction, type SetupRunState, type SetupView } from './setup-view'
export { clearUpdatedNotice } from './silent-update'
export { joinUpdate, lastUpdateOutcome, lastUpdateRun, runUpdate, watchUpdateRestart, type LastUpdateRun, type UpdateDeps, type UpdateOutcome, type UpdateStep } from './update-run'
export { askedOnOpen, offerOf, PENDING_UPDATE_RUN, retryTarget, targetOf, updateScreenView, updateSteps, updateView, type UpdateAction, type UpdateRunState, type UpdateTarget, type UpdateView } from './update-view'
export { usePluginNotice } from './use-plugin-notice'
export { serverCheckKey, useServerCheck } from './use-server-check'
export { useUpdateTrigger, type UpdateTriggerInput } from './use-update-trigger'
