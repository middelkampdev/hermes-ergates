/** Public API of the settings feature (ADR-029): screens, UI and other features import only this file. */
export { APPEARANCE_LABELS, appearanceSummary, isSelectedTheme, type AppearanceMode } from './appearance'
export { connectGateway, connectionToSignIn, probeGateway, signInAgain, signOut, usePrimaryConnection } from './connections'
export { BLANK_CREDENTIALS, credentialsFrom, credentialsReady, firstProvider, type CredentialValues, type SignInMode } from './credentials'
