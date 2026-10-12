/** Public API of the server feature (ADR-029): screens, UI and other features import only this file. */
export { PLUGIN_IDENTIFIER, PLUGIN_NAME, parseBuildRecord, type BuildRecord, type HermesRange, type RequiredPlugin } from './build-record'
export { hermesFit, parseHermesVersion, type HermesFit } from './hermes-version'
export { checkServer, pluginFits, type InstallKind, type PluginFit, type ServerCheck } from './server-check'
export { serverCheckKey, useServerCheck } from './use-server-check'
