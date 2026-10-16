/**
 * Connection registry actions (docs/03 section 4, docs/05 section 3):
 * add a gateway, sign in, sign in again, sign out with clearing, pick the primary.
 */

import { normalizeBaseUrl } from '@/gateway/address'
import { userMessage } from '@/gateway/errors'
import type { ConnectedGateway } from '@/gateway/port'
import type { GatewayRegistry } from '@/gateway/registry'
import type { BackendStatus, Credentials } from '@/gateway/types'
import { useDeviceStore, type Connection } from '@/state/device-store'

import { addressGrade, connectionGrade, gradeLine, PASSWORD_TOO_SHORT, passwordProblem, type ConnectionGrade } from './connection-grade'

export type ConnectInput =
  | { label: string; baseUrl: string; mode: 'token'; token: string }
  | { label: string; baseUrl: string; mode: 'password'; provider: string; username: string; password: string }

export function newConnectionId(): string {
  const rand = Math.random().toString(36).slice(2, 10)
  return `c-${Date.now().toString(36)}-${rand}`
}

/**
 * The app refused to sign in: the server is graded unsafe, or the password is too short for a public one.
 * The message is the plain text to show, and the grade tells the screen which guide to offer.
 */
export class SignInRefused extends Error {
  readonly grade: ConnectionGrade

  constructor(message: string, grade: ConnectionGrade) {
    super(message)
    this.name = 'SignInRefused'
    this.grade = grade
  }
}

/** What a screen shows for a failed connect or sign-in: the plain message, and the grade when the app refused. */
export interface SignInFailure {
  message: string
  grade: ConnectionGrade | null
}

export function signInFailure(err: unknown): SignInFailure {
  return { message: (err as Error).message, grade: err instanceof SignInRefused ? err.grade : null }
}

/**
 * Discover auth mode before asking for credentials. An address that is unsafe by itself (a public address
 * over plain http) is refused without a request: asking it would already send one in plain text. The
 * throwaway gateway that asked is never used again, so whatever its status read stored is removed.
 */
export async function probeGateway(registry: GatewayRegistry, baseUrl: string): Promise<BackendStatus> {
  const address = normalizeBaseUrl(baseUrl)
  const grade = addressGrade(address)
  if (grade?.kind === 'unsafe') {
    throw new SignInRefused(gradeLine(grade, ''), grade)
  }
  const gateway = registry.probe(newConnectionId(), address)
  try {
    return await gateway.status()
  } finally {
    await removeStoredSecrets(gateway)
  }
}

/**
 * A server may set a session cookie on any answer, and the gateway stores it under its connection id. A
 * gateway that never becomes a saved connection must not leave that cookie behind. It has not signed in,
 * so signing it out sends no request: it only removes what is stored for its id.
 */
async function removeStoredSecrets(gateway: ConnectedGateway): Promise<void> {
  await gateway.logout().catch(() => undefined)
}

/**
 * Throws `SignInRefused` unless the app may send these credentials to this server. The address grades
 * first, with no request; only a public https address or a `*.ts.net` name has to say whether it asks for
 * a password, with a fresh status read. Nothing is sent to an unsafe server, and a public server gets no
 * password under the minimum.
 */
async function requireSafeSignIn(gateway: ConnectedGateway, baseUrl: string, creds: Credentials): Promise<void> {
  const grade = addressGrade(baseUrl) ?? connectionGrade(baseUrl, await gateway.status())
  if (grade.kind === 'unsafe') {
    throw new SignInRefused(gradeLine(grade, ''), grade)
  }
  if (creds.mode === 'password' && passwordProblem(grade, creds.password) === 'too_short') {
    throw new SignInRefused(PASSWORD_TOO_SHORT, grade)
  }
}

export async function connectGateway(registry: GatewayRegistry, input: ConnectInput): Promise<Connection> {
  const id = newConnectionId()
  const baseUrl = normalizeBaseUrl(input.baseUrl)
  const record: Connection = {
    id,
    label: input.label.trim() || baseUrl.replace(/^https?:\/\//, ''),
    baseUrl,
    authMode: input.mode,
    primary: true,
    createdAt: Date.now()
  }
  const creds: Credentials =
    input.mode === 'token'
      ? { mode: 'token', token: input.token.trim() }
      : { mode: 'password', provider: input.provider, username: input.username, password: input.password }
  const gateway = registry.get(record)
  try {
    await requireSafeSignIn(gateway, baseUrl, creds)
    await gateway.login(creds)
  } catch (err) {
    await removeStoredSecrets(gateway)
    registry.forget(id)
    throw plainError(err)
  }
  const store = useDeviceStore.getState()
  store.addConnection(record)
  store.setPrimaryConnection(id)
  return record
}

/**
 * Signs a saved connection in again, in place: after an expired session, or on
 * a rooted phone, where the sign-in lives in memory only and is gone after every
 * restart. The connection keeps its id, so its drafts, outbox, agent setups and
 * organization stay. A rejected sign-in throws the plain message to show. The
 * connection was graded when it was saved, but the grade is worked out again:
 * a connection saved by an earlier version was never graded, and a server can
 * change how it signs in. A sign-in in the other mode (the screen picks the
 * fields from a fresh status read) saves that mode on the same connection.
 */
export async function signInAgain(registry: GatewayRegistry, connection: Connection, creds: Credentials): Promise<void> {
  const trimmed: Credentials = creds.mode === 'token' ? { mode: 'token', token: creds.token.trim() } : creds
  const gateway = registry.get(connection)
  try {
    await requireSafeSignIn(gateway, connection.baseUrl, trimmed)
    await gateway.login(trimmed)
  } catch (err) {
    throw plainError(err)
  }
  if (trimmed.mode !== connection.authMode) {
    useDeviceStore.getState().updateConnection(connection.id, { authMode: trimmed.mode })
  }
}

/** A refusal keeps its grade for the screen; any other failure becomes the plain message to show. */
function plainError(err: unknown): Error {
  return err instanceof SignInRefused ? err : new Error(userMessage(err))
}

/** Sign out: revoke on the server where supported, close sockets, clear secrets and device data for that connection. */
export async function signOut(registry: GatewayRegistry, connection: Connection): Promise<void> {
  const gateway = registry.get(connection)
  try {
    await gateway.logout()
  } finally {
    // Connection removal must not depend on the best-effort /auth/logout succeeding.
    await gateway.clearCookies().catch(() => undefined)
    registry.forget(connection.id)
    await useDeviceStore.getState().removeConnection(connection.id)
  }
}

function primaryConnection(connections: Connection[]): Connection | null {
  return connections.find(c => c.primary) ?? connections[0] ?? null
}

export function usePrimaryConnection(): Connection | null {
  return useDeviceStore(s => primaryConnection(s.connections))
}

/** The connection `/sign-in?connection=<id>` signs in again; without a known id, the primary one. */
export function connectionToSignIn(connections: Connection[], id: string | undefined): Connection | null {
  return (id ? connections.find(c => c.id === id) : undefined) ?? primaryConnection(connections)
}
