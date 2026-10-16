/**
 * The line Home shows above the roster when the roster cannot load, or when
 * the server no longer accepts the sign-in (the session ended while the app
 * was open, or Hermes restarted). A pull cannot help then, so the line offers
 * the Sign-in screen instead. Only on a tap: the roster already on screen
 * stays readable until the owner chooses to leave it. When the app itself
 * refused to send the reads (plain `http` to an address that may be public,
 * on a connection saved before the app graded addresses), the line says why.
 */
import { PUBLIC_HTTP_REFUSAL } from '@/gateway/address'
import { isGatewayError } from '@/gateway/errors'

export interface HomeErrorLine {
  text: string
  /** A tap on the line opens the Sign-in screen for this connection. */
  signIn: boolean
}

function isUnauthorized(error: unknown): boolean {
  return isGatewayError(error) && error.kind === 'unauthorized'
}

function isRefusedTransport(error: unknown): boolean {
  return isGatewayError(error) && error.kind === 'insecure_transport'
}

/**
 * The line for the roster's error and the server check's error, or null when
 * there is nothing to say. Either 401 asks for a new sign-in: after a restart
 * the roster fails over the socket, which carries no 401, while the check's
 * HTTP read gets it. A refusal by the app comes first: a pull cannot help,
 * and neither can a sign-in, since the app sends nothing to that address.
 */
export function homeErrorLine(rosterError: unknown, checkError: unknown): HomeErrorLine | null {
  if (isRefusedTransport(rosterError) || isRefusedTransport(checkError)) {
    return { text: PUBLIC_HTTP_REFUSAL, signIn: false }
  }
  if (isUnauthorized(rosterError) || isUnauthorized(checkError)) {
    return { text: 'Sign-in required. Tap to sign in again.', signIn: true }
  }
  if (!rosterError) {
    return null
  }
  return { text: 'Could not load your assistants. Pull to retry.', signIn: false }
}
