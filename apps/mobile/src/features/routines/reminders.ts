/**
 * New routines go through the Ergates reminder route (docs/11 section 4.3),
 * never raw `cron.manage add`: the server keeps a receipt per request id, so
 * a resend of the same request answers with the same receipt instead of a
 * second cron job.
 *
 * Rules:
 *  - one request id per reminder the user tries to create; the same reminder
 *    sent again (a deliberate "Try again") reuses it, a changed one gets a new id;
 *  - an uncertain answer (202, a server failure, or no answer at all) is never
 *    resent by the app;
 *  - the label is the routine's name, which the user types: never prompt text.
 *
 * Pure: the screen renders this.
 */

import { MISSING_NOTICE } from '@/features/server'
import { isGatewayError, userMessage } from '@/gateway/errors'
import type { ReminderOutcome, ReminderRequest } from '@/gateway/types'

/** The routine form's fields (the same shape as `RoutineDraft`). */
export interface ReminderDraft {
  title: string
  instruction: string
  schedule: string
}

/**
 * A request id for one create attempt: `rem-<time>-<16 random base-36 digits>`.
 * The server keys receipts by request id across every profile of the install,
 * so the id is random: never derived from the profile, the label or a counter.
 */
export function newRequestId(now: number = Date.now(), random: () => number = Math.random): string {
  const part = () => Math.floor(random() * 36 ** 8).toString(36).padStart(8, '0')
  return `rem-${now.toString(36)}-${part()}${part()}`
}

/** The request id of each distinct reminder one form sent, keyed on the fields the server compares. */
export class ReminderAttempts {
  private readonly ids = new Map<string, string>()

  constructor(private readonly newId: () => string = () => newRequestId()) {}

  requestFor(profile: string, draft: ReminderDraft, timezone: string): ReminderRequest {
    const body = { profile, schedule: draft.schedule.trim(), timezone, prompt: draft.instruction.trim(), label: draft.title.trim() }
    // The server's payload is profile, schedule, timezone and prompt; the label only names the job.
    const key = JSON.stringify([body.profile, body.schedule, body.timezone, body.prompt])
    let id = this.ids.get(key)
    if (!id) {
      id = this.newId()
      this.ids.set(key, id)
    }
    return { ...body, request_id: id }
  }
}

export type ReminderResult =
  | { kind: 'created' }
  | { kind: 'uncertain'; message: string }
  | { kind: 'conflict'; message: string }
  | { kind: 'invalid'; message: string }
  | { kind: 'failed'; message: string }

const UNCERTAIN =
  'The server could not confirm this routine. Check the Routines list first. Trying again with the same details never makes a second one.'

/** What the form shows after one create call: the outcome it resolved with, or the error it rejected with. */
export function reminderResult(outcome: ReminderOutcome | undefined, error: unknown): ReminderResult {
  if (outcome) {
    switch (outcome.status) {
      case 'created':
      case 'existing':
        return { kind: 'created' }
      case 'uncertain':
        return { kind: 'uncertain', message: UNCERTAIN }
      case 'conflict':
        return { kind: 'conflict', message: 'This request was already used for a different routine. Change a detail and save again.' }
    }
  }
  if (isGatewayError(error)) {
    // A 5xx can come after the cron job was made (the server may answer 503
    // once Hermes created it), so it is no proof that nothing was created.
    if (error.kind === 'timeout' || error.kind === 'network' || (error.status ?? 0) >= 500) {
      return { kind: 'uncertain', message: UNCERTAIN }
    }
    if (error.code === 'invalid') {
      return { kind: 'invalid', message: error.message }
    }
    if (error.code === 'unknown_profile') {
      return { kind: 'failed', message: 'This agent no longer exists on the gateway.' }
    }
    if (error.kind === 'not_found') {
      // The form shows the server check's own notice when it has one; this is the answer when it has not been read yet.
      return { kind: 'failed', message: MISSING_NOTICE.text }
    }
  }
  return { kind: 'failed', message: userMessage(error) }
}
