/**
 * What a password prompt card shows for each method, and the one value it
 * sends (`PromptMethod`). Plain code over the card's fields, so Node tests
 * check every method. The wording follows the requests' own descriptions
 * (tui_gateway/contracts/server_requests.py:137-189) and Hermes Desktop's
 * prompt dialogs (apps/desktop/src/components/prompt-overlays.tsx at the pin).
 */

import type { PromptMethod } from '@/gateway/types'

import type { ChatItem, PromptFields } from './history'

type PromptItem = Extract<ChatItem, { kind: 'prompt' }>

export type PromptEntryKey = 'value' | 'identifier' | 'password'

/** One field of the card. `autofill` is the hint the card gives the phone: `off` for a server password or a secret. */
export interface PromptEntry {
  key: PromptEntryKey
  label: string
  masked: boolean
  autofill: 'off' | 'password' | 'username' | 'oneTimeCode'
}

export interface PromptView {
  title: string
  body: string[]
  /** `sudo`: the command to check before the password goes out, or null when Hermes did not say. */
  command: string | null
  entries: PromptEntry[]
  send: string
  decline: string
  /** The card's last line after the user declined. */
  declined: string
}

/** What the user typed, by field. It lives in the card's own state only. */
export type PromptEntries = Partial<Record<PromptEntryKey, string>>

export function promptView(method: PromptMethod, fields: PromptFields): PromptView {
  switch (method) {
    case 'sudo':
      return {
        title: 'Administrator password',
        body: [
          fields.command
            ? 'The assistant wants to run this command with sudo on your server. Check it before you enter your password.'
            : 'The assistant asks for your sudo password but did not say for which command. Cancel unless you can see the command in the chat.'
        ],
        command: fields.command ?? null,
        entries: [{ key: 'value', label: 'sudo password', masked: true, autofill: 'off' }],
        send: 'Send',
        decline: 'Cancel',
        declined: 'Cancelled'
      }
    case 'secret':
      return {
        title: fields.envVar ?? 'Secret',
        body: [fields.prompt ?? 'The assistant needs a secret to continue.'],
        command: null,
        entries: [{ key: 'value', label: 'Value', masked: true, autofill: 'off' }],
        send: 'Send',
        decline: 'Cancel',
        declined: 'Cancelled'
      }
    case 'vault.unlock_prompt': {
      const manager = fields.manager ?? 'your password manager'
      return {
        title: `Unlock ${manager}`,
        body: [`The assistant wants to sign in to a site with a login saved in ${manager}. Enter its master password to unlock it for this chat.`],
        command: null,
        entries: [{ key: 'value', label: 'Master password', masked: true, autofill: 'password' }],
        send: 'Unlock',
        decline: 'Keep locked',
        declined: 'Kept locked'
      }
    }
    case 'vault.save_login': {
      const site = fields.site ?? hostOf(fields.origin)
      return {
        title: site ? `Save your ${site} login?` : 'Save this login?',
        body: [`The assistant reached a sign-in page${fields.origin ? ` at ${fields.origin}` : ''} and has no login for it. Hermes saves the login you enter and signs in with it.`],
        command: null,
        entries: [
          { key: 'identifier', label: 'Email or username', masked: false, autofill: 'username' },
          { key: 'password', label: 'Password', masked: true, autofill: 'password' }
        ],
        send: 'Save and sign in',
        decline: "Don't save",
        declined: 'Not saved'
      }
    }
    case 'vault.code':
      return {
        title: fields.site ? `Code for ${fields.site}` : 'Verification code',
        body: [`${fields.site ?? 'The site'} asks for a one-time code from a text message, an email or an authenticator app. Hermes types it into the page.`, ...(fields.hint ? [fields.hint] : [])],
        command: null,
        entries: [{ key: 'value', label: 'Code', masked: false, autofill: 'oneTimeCode' }],
        send: 'Enter code',
        decline: 'Skip',
        declined: 'Skipped'
      }
  }
}

/** The host of a sign-in page address, or the address itself when it does not parse. */
function hostOf(origin: string | undefined): string | undefined {
  if (origin === undefined) {
    return undefined
  }
  try {
    return new URL(origin).host || origin
  } catch {
    return origin
  }
}

/**
 * Whether every field has text. Nothing is trimmed: a password goes to Hermes
 * as typed, and an empty answer would decline the request.
 */
export function canSend(view: PromptView, entries: PromptEntries): boolean {
  return view.entries.every(entry => (entries[entry.key] ?? '').length > 0)
}

/** The `value` the answer carries: the one field as typed, or for a login the JSON `{identifier, password}` Hermes reads. */
export function promptValue(method: PromptMethod, entries: PromptEntries): string {
  if (method === 'vault.save_login') {
    return JSON.stringify({ identifier: entries.identifier ?? '', password: entries.password ?? '' })
  }
  return entries.value ?? ''
}

/** The last line of a settled card, or null while it waits. */
export function promptStateLabel(item: PromptItem): string | null {
  switch (item.state) {
    case 'pending':
      return null
    case 'sent':
      return 'Sent'
    case 'declined':
      return promptView(item.method, item.fields).declined
    case 'expired':
      return 'Expired'
  }
}
