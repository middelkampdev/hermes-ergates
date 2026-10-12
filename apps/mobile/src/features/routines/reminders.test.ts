/**
 * New routines go through the Ergates reminder route (docs/11 section 4.3):
 * one request id per attempt, reused only for a deliberate resend of the same
 * reminder, and never an automatic retry.
 */
import { describe, expect, it } from 'vitest'

import { FakeErgates } from '@test/fake-gateway/fake-ergates'

import { GatewayError, mapErgatesError } from '@/gateway/errors'

import { newRequestId, ReminderAttempts, reminderResult } from './reminders'

const REQUEST_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const draft = { title: 'Invoices', instruction: 'Check the unpaid invoices.', schedule: '0 9 * * *' }

describe('newRequestId', () => {
  it('is unique across every profile of the install, and matches the server rule', () => {
    // The server keys reminder receipts by request id across all profiles, so
    // an id must never repeat per profile or per label.
    const ids = new Set<string>()
    for (let i = 0; i < 2_000; i += 1) {
      const id = newRequestId()
      expect(id).toMatch(REQUEST_ID_RE)
      ids.add(id)
    }
    expect(ids.size).toBe(2_000)
  })

  it('does not depend on the profile or the reminder', () => {
    expect(newRequestId(0, () => 0.5)).toBe('rem-0-i0000000i0000000')
  })
})

describe('ReminderAttempts', () => {
  it('sends the same reminder again under its first id, and a changed one under a new id', () => {
    let n = 0
    const attempts = new ReminderAttempts(() => `rem-${++n}`)

    const first = attempts.requestFor('thijs', draft, 'Europe/Amsterdam')
    expect(first).toEqual({ profile: 'thijs', schedule: '0 9 * * *', timezone: 'Europe/Amsterdam', prompt: 'Check the unpaid invoices.', label: 'Invoices', request_id: 'rem-1' })
    expect(attempts.requestFor('thijs', { ...draft, schedule: ' 0 9 * * * ' }, 'Europe/Amsterdam').request_id).toBe('rem-1')
    expect(attempts.requestFor('thijs', { ...draft, instruction: 'Check the paid ones too.' }, 'Europe/Amsterdam').request_id).toBe('rem-2')
    expect(attempts.requestFor('anna', draft, 'Europe/Amsterdam').request_id).toBe('rem-3')
  })

  it('lets a deliberate resend of an uncertain create end with one job', async () => {
    const ergates = new FakeErgates({ hasProfile: name => name === 'thijs' })
    const attempts = new ReminderAttempts()
    ergates.nextCreateUncertain({ jobCreated: true })

    const first = await ergates.createReminder(attempts.requestFor('thijs', draft, 'Europe/Amsterdam'))
    expect(reminderResult(first, null).kind).toBe('uncertain')
    const again = await ergates.createReminder(attempts.requestFor('thijs', draft, 'Europe/Amsterdam'))

    expect(reminderResult(again, null)).toEqual({ kind: 'created' })
    expect(ergates.jobs).toHaveLength(1)
    expect(ergates.calls.filter(c => c.op === 'createReminder')).toHaveLength(2)
  })

  it('lets a deliberate resend after a server failure that came after the job was made end with one job', async () => {
    const ergates = new FakeErgates({ hasProfile: name => name === 'thijs' })
    const attempts = new ReminderAttempts()
    ergates.failInternal('createReminder', 'after')

    const first = await ergates.createReminder(attempts.requestFor('thijs', draft, 'Europe/Amsterdam')).then(
      () => null,
      (err: unknown) => err
    )
    expect(reminderResult(undefined, first).kind).toBe('uncertain')
    const again = await ergates.createReminder(attempts.requestFor('thijs', draft, 'Europe/Amsterdam'))

    expect(reminderResult(again, null)).toEqual({ kind: 'created' })
    expect(ergates.jobs).toHaveLength(1)
    const ids = ergates.calls.filter(c => c.op === 'createReminder').map(c => (c.args[0] as { request_id: string }).request_id)
    expect(new Set(ids).size).toBe(1)
  })
})

describe('reminderResult', () => {
  it('closes the form for a new or an existing reminder', () => {
    const receipt = { id: 'r', request_id: 'r', profile: 'thijs', state: 'created' as const, job_id: 'j', timezone_advisory: 'UTC', payload_hash: 'h' }
    expect(reminderResult({ status: 'created', receipt }, null)).toEqual({ kind: 'created' })
    expect(reminderResult({ status: 'existing', receipt }, null)).toEqual({ kind: 'created' })
    expect(reminderResult({ status: 'conflict', receipt }, null).kind).toBe('conflict')
  })

  it('treats a lost answer like a 202: uncertain, and only the user resends', () => {
    for (const err of [new GatewayError('timeout', 'The gateway did not answer in time.'), new GatewayError('network', 'No connection to the gateway.')]) {
      expect(reminderResult(undefined, err).kind).toBe('uncertain')
    }
  })

  it('treats a server failure (5xx) as uncertain: the cron job may exist already', () => {
    const errors = [
      mapErgatesError(503, { error: { code: 'store_unavailable', message: 'the Ergates control store is unavailable' } }),
      mapErgatesError(500, { error: { code: 'internal', message: 'The request could not be completed.' } }),
      // A proxy in front of the gateway answers without an Ergates error body.
      mapErgatesError(502, 'Bad Gateway')
    ]
    for (const err of errors) {
      expect(reminderResult(undefined, err)).toEqual({ kind: 'uncertain', message: expect.stringContaining('Check the Routines list first') })
    }
  })

  it('shows the server reason for a refused reminder', () => {
    const invalid = new GatewayError('unknown', 'schedule is not one Hermes cron accepts', { status: 400, code: 'invalid' })
    expect(reminderResult(undefined, invalid)).toEqual({ kind: 'invalid', message: 'schedule is not one Hermes cron accepts' })
    const gone = new GatewayError('not_found', "profile 'nora' does not exist", { status: 404, code: 'unknown_profile' })
    expect(reminderResult(undefined, gone)).toEqual({ kind: 'failed', message: 'This agent no longer exists on the gateway.' })
    const missing = new GatewayError('not_found', 'Not Found', { status: 404 })
    expect(reminderResult(undefined, missing)).toEqual({ kind: 'failed', message: 'Ergates is not set up on this server.' })
  })
})
