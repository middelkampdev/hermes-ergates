/** Public API of the server feature (ADR-029): screens, UI and other features import only this file. */
export { afterSignIn, routeAfterCheck, type SetupRoute } from './after-sign-in'
export { PLUGIN_IDENTIFIER, PLUGIN_NAME, parseBuildRecord, type BuildRecord, type HermesRange, type RequiredPlugin } from './build-record'
export {
  finishVariant,
  finishView,
  isSignedOut,
  manualFromParams,
  pendingCommit,
  RESTART_HEADING,
  SERVER_GUIDE_URL,
  setupProblem,
  SIGNED_OUT_HINT,
  type FinishAction,
  type FinishManual,
  type FinishVariant,
  type FinishView
} from './finish-view'
export { hermesFit, parseHermesVersion, type HermesFit } from './hermes-version'
export { clearPendingSetup, finishPendingSetup, markPendingSetup } from './pending-setup'
export { checkServer, pluginFits, type InstallKind, type PluginFit, type ServerCheck } from './server-check'
export { isSetupRunning, runSetup, type ManualFailure, type SetupDeps, type SetupOutcome, type SetupStep, type StepStatus } from './setup-run'
export { SETUP_TITLE, finishParams, setupView, signedOutView, stepStatusWord, type FinishParams, type SetupAction, type SetupRunState, type SetupView } from './setup-view'
export { serverCheckKey, useServerCheck } from './use-server-check'
