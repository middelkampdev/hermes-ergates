/**
 * What the sign-in fields hold, shared by Connect and Sign in again. One shape
 * for both modes: the screen shows the token field or the provider, username
 * and password fields, depending on how the gateway signs in.
 */

import type { BackendStatus, Credentials } from '@/gateway/types'

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

/** The credentials for `login`, with only the fields of this mode. */
export function credentialsFrom(mode: SignInMode, values: CredentialValues): Credentials {
  return mode === 'password'
    ? { mode: 'password', provider: values.provider, username: values.username, password: values.password }
    : { mode: 'token', token: values.token }
}

/** The provider to preselect: the one the gateway lists first. */
export function firstProvider(status: Pick<BackendStatus, 'auth_providers'>): string | undefined {
  return status.auth_providers?.[0]
}
