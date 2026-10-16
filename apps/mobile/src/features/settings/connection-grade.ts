/**
 * How safe a server connection is, graded before the app signs in: the address
 * decides what it can, and the server's own status decides the rest. Pure, so
 * Node tests cover it. The app never sends a password in plain text to a public
 * server, and never connects to a public server that signs in without one.
 */

import { addressKind, isTailscaleName, usesHttps } from '@/gateway/address'
import type { BackendStatus } from '@/gateway/types'

/** The shortest password the app accepts on a public server, counted in characters as a person sees them. */
export const MIN_PUBLIC_PASSWORD = 12

export type ConnectionGrade =
  | { kind: 'private'; via: 'loopback' | 'tailscale' | 'lan' }
  | { kind: 'public' }
  | { kind: 'unsafe'; reason: 'public_http' | 'public_token' }

/** Where to read about each grade. A public or unsafe server needs the same fix. */
export const GRADE_GUIDE: Record<ConnectionGrade['kind'], string> = {
  private: 'https://middelkamp.dev/ergates/server/#private-access',
  public: 'https://middelkamp.dev/ergates/server/#public-access',
  unsafe: 'https://middelkamp.dev/ergates/server/#public-access'
}

export const PASSWORD_TOO_SHORT = `On a public server, use a password of at least ${MIN_PUBLIC_PASSWORD} characters.`

const PUBLIC_HTTP: ConnectionGrade = { kind: 'unsafe', reason: 'public_http' }
const PUBLIC_TOKEN: ConnectionGrade = { kind: 'unsafe', reason: 'public_token' }

/**
 * The grade the address alone gives, or null when the server has to say whether it asks for a password.
 * A public `http` address is unsafe without a question: asking it would already send a request in plain text.
 */
export function addressGrade(baseUrl: string): ConnectionGrade | null {
  const kind = addressKind(baseUrl)
  if (kind === 'loopback') {
    return { kind: 'private', via: 'loopback' }
  }
  if (kind === 'private') {
    return { kind: 'private', via: 'lan' }
  }
  if (kind === 'tailscale' && !isTailscaleHost(baseUrl)) {
    return { kind: 'private', via: 'tailscale' }
  }
  if (kind === 'public' && !usesHttps(baseUrl)) {
    return PUBLIC_HTTP
  }
  return null
}

/**
 * The grade once the server has said whether it asks for a password. A public address that signs in
 * without a password is unsafe. A `*.ts.net` name counts as private only when it asks for one, because
 * Tailscale Funnel can publish such a name on the open internet.
 */
export function connectionGrade(baseUrl: string, status: Pick<BackendStatus, 'auth_required'>): ConnectionGrade {
  const byAddress = addressGrade(baseUrl)
  if (byAddress) {
    return byAddress
  }
  if (!status.auth_required) {
    return PUBLIC_TOKEN
  }
  return isTailscaleHost(baseUrl) ? { kind: 'private', via: 'tailscale' } : { kind: 'public' }
}

/** Only a public server sets a minimum, counted in code points so an emoji is one character. The password is not trimmed. */
export function passwordProblem(grade: ConnectionGrade, password: string): 'too_short' | null {
  return grade.kind === 'public' && Array.from(password).length < MIN_PUBLIC_PASSWORD ? 'too_short' : null
}

/** The line under the server's name. An unsafe grade has no version: the app never signs in to it. */
export function gradeLine(grade: ConnectionGrade, version: string): string {
  switch (grade.kind) {
    case 'private':
      return `Hermes ${version}. ${PRIVATE_LINES[grade.via]}`
    case 'public':
      return `Hermes ${version}. Ergates treats this address as public, so anyone on the internet may reach it. Use a password of at least ${MIN_PUBLIC_PASSWORD} characters, or connect over Tailscale.`
    case 'unsafe':
      return UNSAFE_LINES[grade.reason]
  }
}

export function gradeLabel(grade: ConnectionGrade): string {
  switch (grade.kind) {
    case 'private':
      return PRIVATE_LABELS[grade.via]
    case 'public':
      return 'Public, encrypted'
    case 'unsafe':
      return 'Unsafe'
  }
}

const PRIVATE_LINES = {
  loopback: 'Private: this server runs on this device.',
  tailscale: 'Private: Tailscale encrypts this connection.',
  lan: 'Private: a server on your local network.'
} satisfies Record<Extract<ConnectionGrade, { kind: 'private' }>['via'], string>

const PRIVATE_LABELS = {
  loopback: 'Private (this device)',
  tailscale: 'Private (Tailscale)',
  lan: 'Private (local network)'
} satisfies Record<Extract<ConnectionGrade, { kind: 'private' }>['via'], string>

const UNSAFE_LINES = {
  public_http: 'This address may be on the public internet without encryption. Ergates connects to a public server only over https.',
  public_token: 'This public server signs in without a password. Ergates connects to a public server only with a password.'
} satisfies Record<Extract<ConnectionGrade, { kind: 'unsafe' }>['reason'], string>

/**
 * A `*.ts.net` name the address classifier trusts. A name behind a user name or a Unicode lookalike is
 * graded as the public address it may be, so it never counts as a Tailscale name here.
 */
function isTailscaleHost(baseUrl: string): boolean {
  return addressKind(baseUrl) === 'tailscale' && isTailscaleName(baseUrl)
}
