/**
 * What the sign-in fields hold, shared by Connect and Sign in again. One shape
 * for both modes: the screen shows the token field or the provider, username
 * and password fields, depending on how the gateway signs in.
 */

import type { BackendStatus, Credentials } from '@/gateway/types'

import type { ConnectionGrade } from './connection-grade'

export type SignInMode = Credentials['mode']

export interface CredentialValues {
  token: string
  provider: string
  username: string
  password: string
}

/** `basic` until the gateway's status names its own first provider. */
export const BLANK_CREDENTIALS: CredentialValues = { token: '', provider: 'basic', username: '', password: '' }

/** Whether the fields of this mode are filled in enough to send. */
export function credentialsReady(mode: SignInMode, values: CredentialValues): boolean {
  return mode === 'password' ? Boolean(values.username.trim() && values.password) : Boolean(values.token.trim())
}

/**
 * Whether Connect can go ahead: the server has answered (it has a grade), the app does not refuse that
 * grade, and the fields are filled in. A null grade means the address has not been checked yet.
 */
export function canConnect(grade: ConnectionGrade | null, mode: SignInMode, values: CredentialValues): boolean {
  return grade !== null && grade.kind !== 'unsafe' && credentialsReady(mode, values)
}

/** The credentials for `login`, with only the fields of this mode. */
export function credentialsFrom(mode: SignInMode, values: CredentialValues): Credentials {
  return mode === 'password'
    ? { mode: 'password', provider: values.provider, username: values.username, password: values.password }
    : { mode: 'token', token: values.token }
}

/**
 * Which fields to show: the mode the server signs in with now, once it has answered, else the saved one.
 * A server can switch between a session token and a password after the connection was saved.
 */
export function signInModeFrom(status: Pick<BackendStatus, 'auth_required'> | null, saved: SignInMode): SignInMode {
  if (!status) {
    return saved
  }
  return status.auth_required ? 'password' : 'token'
}

/** The provider to preselect: the one the gateway lists first. */
export function firstProvider(status: Pick<BackendStatus, 'auth_providers'>): string | undefined {
  return status.auth_providers?.[0]
}
