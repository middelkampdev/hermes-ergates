/**
 * The sign-in fields of Connect and Sign in again: a session token for a
 * loopback gateway, or a provider, username and password.
 */

import type { CredentialValues, SignInMode } from '@/features/settings'

import { Field } from './Field'

export interface CredentialFieldsProps {
  mode: SignInMode
  values: CredentialValues
  /** Gets only the field that changed; the screen merges it into its own state. */
  onChange: (patch: Partial<CredentialValues>) => void
}

export function CredentialFields({ mode, values, onChange }: CredentialFieldsProps) {
  if (mode === 'token') {
    return <Field label="Session token" value={values.token} onChangeText={token => onChange({ token })} placeholder="HERMES_DASHBOARD_SESSION_TOKEN" secureTextEntry />
  }
  return (
    <>
      <Field label="Provider" value={values.provider} onChangeText={provider => onChange({ provider })} />
      <Field label="Username" value={values.username} onChangeText={username => onChange({ username })} />
      <Field label="Password" value={values.password} onChangeText={password => onChange({ password })} secureTextEntry />
    </>
  )
}
