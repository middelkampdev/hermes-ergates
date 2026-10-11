/**
 * The line Home shows above the roster when the roster cannot load. When the
 * server no longer accepts the sign-in (the session ended while the app was
 * open), a pull cannot help, so the line offers the Sign-in screen instead.
 * Only on a tap: the roster already on screen stays readable until the owner
 * chooses to leave it.
 */
import { isGatewayError } from '@/gateway/errors'

export interface HomeErrorLine {
  text: string
  /** A tap on the line opens the Sign-in screen for this connection. */
  signIn: boolean
}

export function homeErrorLine(error: unknown): HomeErrorLine {
  if (isGatewayError(error) && error.kind === 'unauthorized') {
    return { text: 'Sign-in required. Tap to sign in again.', signIn: true }
  }
  return { text: 'Could not load your assistants. Pull to retry.', signIn: false }
}
