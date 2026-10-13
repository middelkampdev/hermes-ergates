/**
 * The line Home shows above the roster when the roster cannot load, or when
 * the server no longer accepts the sign-in (the session ended while the app
 * was open, or Hermes restarted). A pull cannot help then, so the line offers
 * the Sign-in screen instead. Only on a tap: the roster already on screen
 * stays readable until the owner chooses to leave it.
 */
import { isGatewayError } from '@/gateway/errors'

export interface HomeErrorLine {
  text: string
  /** A tap on the line opens the Sign-in screen for this connection. */
  signIn: boolean
}

function isUnauthorized(error: unknown): boolean {
  return isGatewayError(error) && error.kind === 'unauthorized'
}

/**
 * The line for the roster's error and the server check's error, or null when
 * there is nothing to say. Either 401 asks for a new sign-in: after a restart
 * the roster fails over the socket, which carries no 401, while the check's
 * HTTP read gets it.
 */
export function homeErrorLine(rosterError: unknown, checkError: unknown): HomeErrorLine | null {
  if (isUnauthorized(rosterError) || isUnauthorized(checkError)) {
    return { text: 'Sign-in required. Tap to sign in again.', signIn: true }
  }
  if (!rosterError) {
    return null
  }
  return { text: 'Could not load your assistants. Pull to retry.', signIn: false }
}
