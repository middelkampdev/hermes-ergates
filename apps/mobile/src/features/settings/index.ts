/** Public API of the settings feature (ADR-029): screens, UI and other features import only this file. */
export { APPEARANCE_LABELS, appearanceSummary, isSelectedTheme, type AppearanceMode } from './appearance'
export {
  addressGrade,
  connectionGrade,
  GRADE_GUIDE,
  gradeLabel,
  gradeLine,
  guideLabel,
  MIN_PUBLIC_PASSWORD,
  PASSWORD_TOO_SHORT,
  passwordProblem,
  type ConnectionGrade
} from './connection-grade'
export { connectGateway, connectionToSignIn, probeGateway, signInAgain, SignInRefused, signOut, usePrimaryConnection } from './connections'
export { BLANK_CREDENTIALS, credentialsFrom, credentialsReady, firstProvider, type CredentialValues, type SignInMode } from './credentials'
