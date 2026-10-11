import { describe, expect, it } from 'vitest'

import {
  CUT_MARKER_RE,
  PROCESS_TITLE_RE,
  deliveryFromReason,
  deliveryFromStatus,
  parseReceiptRow,
  parseSingleReceipt,
  readBody,
  workerFromHeadline,
  type ParsedReceipt,
} from './receipt'

import receiptCli from '@test/fixtures/agent-traffic/receipt-cli.json'
import receiptCliSecond from '@test/fixtures/agent-traffic/receipt-cli-second.json'
import receiptCliCut from '@test/fixtures/agent-traffic/receipt-cli-cut.json'
import receiptRefusalJson from '@test/fixtures/agent-traffic/receipt-refusal-json.json'
import receiptLiveJson from '@test/fixtures/agent-traffic/receipt-live-json.json'
import receiptLiveAmbiguous from '@test/fixtures/agent-traffic/receipt-live-ambiguous.json'
import receiptLiveFailed from '@test/fixtures/agent-traffic/receipt-live-failed.json'
import receiptLiveCancelled from '@test/fixtures/agent-traffic/receipt-live-cancelled.json'
import receiptRelayReply from '@test/fixtures/agent-traffic/receipt-relay-reply.json'
import receiptRelayEmpty from '@test/fixtures/agent-traffic/receipt-relay-empty.json'
import receiptRelayFailure from '@test/fixtures/agent-traffic/receipt-relay-failure.json'
import receiptRelayTimeout from '@test/fixtures/agent-traffic/receipt-relay-timeout.json'
import receiptSubagentTrimmed from '@test/fixtures/agent-traffic/receipt-subagent-trimmed.json'
import receiptDamaged from '@test/fixtures/agent-traffic/receipt-damaged.json'
import receiptDamagedBrace from '@test/fixtures/agent-traffic/receipt-damaged-brace.json'
import receiptExitNone from '@test/fixtures/agent-traffic/receipt-exit-none.json'
import receiptSigterm from '@test/fixtures/agent-traffic/receipt-sigterm.json'
import receiptLost from '@test/fixtures/agent-traffic/receipt-lost.json'
import receiptBatchTwo from '@test/fixtures/agent-traffic/receipt-batch-two.json'
import receiptBatchThree from '@test/fixtures/agent-traffic/receipt-batch-three.json'
import receiptWatchMatch from '@test/fixtures/agent-traffic/receipt-watch-match.json'

interface ReceiptFixture {
  text: string
  result: Record<string, unknown> | null
  expect: {
    processId?: string
    delivery?: string
    reply?: string
    worker?: string
    latestOutcomeUnavailable?: boolean
    count?: number
    notice?: string
  }
}

const asFixture = (value: unknown): ReceiptFixture => value as ReceiptFixture

// -----------------------------------------------------------------------
// Fixture-driven table: every single-receipt fixture must parse, resolve
// its worker and read its body exactly as the fixture's `expect` says.
// -----------------------------------------------------------------------

const singleReceiptFixtures: [string, ReceiptFixture][] = [
  ['receipt-cli', asFixture(receiptCli)],
  ['receipt-cli-second', asFixture(receiptCliSecond)],
  ['receipt-cli-cut', asFixture(receiptCliCut)],
  ['receipt-refusal-json', asFixture(receiptRefusalJson)],
  ['receipt-live-json', asFixture(receiptLiveJson)],
  ['receipt-live-ambiguous', asFixture(receiptLiveAmbiguous)],
  ['receipt-live-failed', asFixture(receiptLiveFailed)],
  ['receipt-live-cancelled', asFixture(receiptLiveCancelled)],
  ['receipt-relay-reply', asFixture(receiptRelayReply)],
  ['receipt-relay-empty', asFixture(receiptRelayEmpty)],
  ['receipt-relay-failure', asFixture(receiptRelayFailure)],
  ['receipt-relay-timeout', asFixture(receiptRelayTimeout)],
  ['receipt-subagent-trimmed', asFixture(receiptSubagentTrimmed)],
  ['receipt-damaged', asFixture(receiptDamaged)],
  ['receipt-damaged-brace', asFixture(receiptDamagedBrace)],
  ['receipt-exit-none', asFixture(receiptExitNone)],
  ['receipt-sigterm', asFixture(receiptSigterm)],
  ['receipt-lost', asFixture(receiptLost)],
]

describe.each(singleReceiptFixtures)('%s', (_name, fixture) => {
  it('parses to one receipt and reads the body per the fixture expectations', () => {
    const parsed = parseReceiptRow(fixture.text)
    expect(parsed.kind).toBe('receipts')
    if (parsed.kind !== 'receipts') throw new Error('unreachable')
    expect(parsed.receipts).toHaveLength(1)

    const receipt = parsed.receipts[0]!
    expect(receipt.headline.processId).toBe(fixture.expect.processId)
    expect(workerFromHeadline(receipt.headline).kind).toBe(fixture.expect.worker)

    const reading = readBody(receipt, { pairedResultIsLiveOwner: Boolean(fixture.result && 'delivery_id' in fixture.result && !('queued_at' in fixture.result)) })
    expect(reading.kind).toBe('outcome')
    if (reading.kind !== 'outcome') throw new Error('unreachable')
    expect(reading.delivery).toBe(fixture.expect.delivery)
    expect(reading.reply.kind).toBe(fixture.expect.reply)
    expect(reading.latestOutcomeUnavailable).toBe(Boolean(fixture.expect.latestOutcomeUnavailable))
  })
})

// -----------------------------------------------------------------------
// Batch fixtures: parse as `{ kind: 'receipts' }` with the expected count.
// -----------------------------------------------------------------------

const batchFixtures: [string, ReceiptFixture][] = [
  ['receipt-batch-two', asFixture(receiptBatchTwo)],
  ['receipt-batch-three', asFixture(receiptBatchThree)],
]

describe.each(batchFixtures)('%s', (_name, fixture) => {
  it('parses as a batch with the expected receipt count', () => {
    const parsed = parseReceiptRow(fixture.text)
    expect(parsed.kind).toBe('receipts')
    if (parsed.kind !== 'receipts') throw new Error('unreachable')
    expect(typeof fixture.expect.count).toBe('number')
    expect(parsed.receipts).toHaveLength(fixture.expect.count as number)
  })
})

// -----------------------------------------------------------------------
// Notice fixture.
// -----------------------------------------------------------------------

it('parses the watch-match fixture as a process notice', () => {
  const fixture = asFixture(receiptWatchMatch)
  expect(parseReceiptRow(fixture.text)).toEqual({ kind: 'notice', noticeKind: fixture.expect.notice })
})

// -----------------------------------------------------------------------
// Targeted grammar and mapping tests (brief, verbatim).
// -----------------------------------------------------------------------

it('takes the body up to the LAST bracket and requires it to be the final character', () => {
  const text = '[IMPORTANT: Background process proc_0123456789ab completed normally (exit code 0).\nCommand: x\nOutput:\nline with ] inside\nlast]'
  const r = parseSingleReceipt(text)!
  expect(r.body).toBe('line with ] inside\nlast')
  expect(parseSingleReceipt(text + ' trailing')).toBeNull()
})

it('keeps attribution lines and a multi-line command out of the body', () => {
  const text = '[IMPORTANT: Background process proc_0123456789ab exited (exit code 1).\nStarted by subagent sa-1 (delegate_task).\nCommand: python -c "a\nb"\nOutput:\nhello]'
  const r = parseSingleReceipt(text)!
  expect(r.attribution).toEqual(['Started by subagent sa-1 (delegate_task).'])
  expect(r.command).toBe('python -c "a\nb"')
  expect(r.body).toBe('hello')
  expect(workerFromHeadline(r.headline)).toEqual({ kind: 'exited', code: 1 })
})

it('maps ?, None and SIGTERM', () => {
  expect(parseSingleReceipt('[IMPORTANT: Background process proc_0123456789ab exited (exit code None).\nCommand: x\nOutput:\n]')!.headline).toMatchObject({ exitCode: 'unknown', sigterm: false })
  expect(parseSingleReceipt('[IMPORTANT: Background process proc_0123456789ab terminated by Hermes (exit code -15, SIGTERM).\nCommand: x\nOutput:\n]')!.headline).toMatchObject({ exitCode: -15, sigterm: true, description: 'terminated by Hermes' })
  expect(workerFromHeadline({ processId: 'p', description: 'terminated by Hermes', exitCode: -15, sigterm: true })).toEqual({ kind: 'terminated', by: 'Hermes' })
  expect(workerFromHeadline({ processId: 'p', description: 'marked lost because the process backend disappeared', exitCode: 'unknown', sigterm: false })).toEqual({ kind: 'lost' })
  expect(workerFromHeadline({ processId: 'p', description: 'failed to start', exitCode: 'unknown', sigterm: false })).toEqual({ kind: 'failed_start' })
})

it('accepts a batch only when the split yields exactly N well-formed receipts', () => {
  const one = (id: string, out: string) => `[IMPORTANT: Background process ${id} completed normally (exit code 0).\nCommand: c\nOutput:\n${out}]`
  const good = `[IMPORTANT: 2 background processes completed. Treat these results as one batch.]\n\n${one('proc_0123456789ab', 'a')}\n\n${one('proc_0123456789ac', 'b')}`
  expect(parseReceiptRow(good)).toMatchObject({ kind: 'receipts', receipts: [{ headline: { processId: 'proc_0123456789ab' } }, { headline: { processId: 'proc_0123456789ac' } }] })
  const wrongCount = good.replace('2 background', '3 background')
  expect(parseReceiptRow(wrongCount)).toEqual({ kind: 'notice', noticeKind: 'batch' })
  const overSplit = `[IMPORTANT: 1 background processes completed. x]\n\n${one('proc_0123456789ab', 'tail]\n\n[IMPORTANT: Background process proc_0123456789ac completed normally (exit code 0).\nCommand: c\nOutput:\nb')}`
  expect(parseReceiptRow(overSplit)).toEqual({ kind: 'notice', noticeKind: 'batch' })
})

it('turns watch matches and unknown IMPORTANT rows into notices, and other text into none', () => {
  expect(parseReceiptRow('[IMPORTANT: Background process proc_0123456789ab matched watch pattern "x".\nCommand: c\nMatched output:\ny]')).toEqual({ kind: 'notice', noticeKind: 'process' })
  expect(parseReceiptRow('[IMPORTANT: watch disabled]')).toEqual({ kind: 'notice', noticeKind: 'unknown' })
  expect(parseReceiptRow('Message from 🤖 kevin (@kevin): hi')).toEqual({ kind: 'none' })
})

describe('readBody order', () => {
  const rec = (body: string, exitCode: number | 'unknown' = 0, trimmed = false, cut: number | null = null): ParsedReceipt => ({ headline: { processId: 'proc_0123456789ab', description: 'exited', exitCode, sigterm: false }, attribution: [], command: 'c', body, trimmed, cut, raw: '' })

  it('JSON with status', () => {
    expect(readBody(rec('{"status":"settled","delivery_id":"d","reply":"Tue"}'), { pairedResultIsLiveOwner: true })).toMatchObject({ kind: 'outcome', delivery: 'settled', reply: { kind: 'text', body: 'Tue', completeness: 'complete' }, deliveryId: 'd' })
    expect(readBody(rec('{"status":"settled","delivery_id":"d"}'), { pairedResultIsLiveOwner: true })).toMatchObject({ delivery: 'settled', reply: { kind: 'empty' } })
    expect(readBody(rec('{"status":"ambiguous","delivery_id":"d"}'), { pairedResultIsLiveOwner: true })).toMatchObject({ delivery: 'unknown', reply: { kind: 'none' } })
    expect(readBody(rec('{"status":"failed","reason":"provider_rate_limit","error":"x"}'), { pairedResultIsLiveOwner: true })).toMatchObject({ delivery: 'failed', reason: 'provider_rate_limit' })
    expect(readBody(rec('{"status":"failed","reason":"delivery_timeout"}'), { pairedResultIsLiveOwner: true })).toMatchObject({ delivery: 'unknown' })
  })

  it('JSON with error and no status: refusal or failure by reason', () => {
    expect(readBody(rec('{"error":"busy","reason":"target_busy"}'), { pairedResultIsLiveOwner: false })).toMatchObject({ delivery: 'refused', reply: { kind: 'none' } })
    expect(readBody(rec('{"error":"no such","reason":"unknown"}'), { pairedResultIsLiveOwner: false })).toMatchObject({ delivery: 'unknown' })
    expect(readBody(rec('{"error":"x","reason":"cancelled"}'), { pairedResultIsLiveOwner: false })).toMatchObject({ delivery: 'cancelled' })
    expect(readBody(rec('{"error":"x","reason":"made_up_code"}'), { pairedResultIsLiveOwner: false })).toMatchObject({ delivery: 'unknown' })
  })

  it('JSON object without status or error is a delivery_update notice', () => {
    expect(readBody(rec('{"detail":"queued"}'), { pairedResultIsLiveOwner: false })).toEqual({ kind: 'notice' })
  })

  it('relay failure, timeout, reply', () => {
    expect(readBody(rec('Delivery to @kevin on peer failed [reason: runtime_offline]: down'), { pairedResultIsLiveOwner: false })).toMatchObject({ delivery: 'refused', reason: 'runtime_offline' })
    expect(readBody(rec('Delivery to @kevin on peer failed: down'), { pairedResultIsLiveOwner: false })).toMatchObject({ delivery: 'unknown', reason: 'unknown' })
    expect(readBody(rec('No reply from @kevin on peer within 600s. The message may still be delivered'), { pairedResultIsLiveOwner: false })).toMatchObject({ delivery: 'unknown', reply: { kind: 'none' }, latestOutcomeUnavailable: true })
    expect(readBody(rec('Reply from @kevin on peer:\nTuesday.'), { pairedResultIsLiveOwner: false })).toMatchObject({ delivery: 'settled', reply: { kind: 'text', body: 'Tuesday.', completeness: 'unknown' } })
    expect(readBody(rec('Reply from @kevin on peer:\n(empty reply)'), { pairedResultIsLiveOwner: false })).toMatchObject({ reply: { kind: 'empty' } })
    expect(readBody(rec('Reply from @kevin on peer:\n'), { pairedResultIsLiveOwner: false })).toMatchObject({ delivery: 'settled', reply: { kind: 'empty' } })
  })

  it('damaged: a brace start, or a paired live-owner ack even when the tail is prose', () => {
    expect(readBody(rec('{"status":"sett'), { pairedResultIsLiveOwner: false })).toMatchObject({ delivery: 'unknown', reply: { kind: 'damaged' } })
    expect(readBody(rec('ly","reply":"prose tail"}'), { pairedResultIsLiveOwner: true })).toMatchObject({ reply: { kind: 'damaged' } })
  })

  it('CLI text drops session lines; empty remainder depends on the exit code; trimmed text is an excerpt', () => {
    expect(readBody(rec('session_id: abc\n↻ Resumed session x\nTuesday works.'), { pairedResultIsLiveOwner: false })).toMatchObject({ delivery: 'settled', reply: { kind: 'text', body: 'Tuesday works.' } })
    expect(readBody(rec('session_id: abc\n', 0), { pairedResultIsLiveOwner: false })).toMatchObject({ delivery: 'settled', reply: { kind: 'empty' } })
    expect(readBody(rec('', 1), { pairedResultIsLiveOwner: false })).toMatchObject({ delivery: 'unknown', reply: { kind: 'none' } })
    expect(readBody(rec('tail of the reply', 0, true), { pairedResultIsLiveOwner: false })).toMatchObject({ reply: { kind: 'excerpt', body: 'tail of the reply' } })
    expect(readBody(rec('{"error":"x","reason":"target_busy"}', 1, true), { pairedResultIsLiveOwner: false })).toMatchObject({ reply: { kind: 'none' } })
  })

  it('reads cut text as an excerpt on the reply branches only', () => {
    expect(readBody(rec('tail of the reply', 0, false, 3072), { pairedResultIsLiveOwner: false })).toMatchObject({ delivery: 'settled', reply: { kind: 'excerpt', body: 'tail of the reply' } })
    expect(readBody(rec('Reply from @kevin on laptop:\nthe end', 0, false, 3072), { pairedResultIsLiveOwner: false })).toMatchObject({ delivery: 'settled', reply: { kind: 'excerpt', body: 'the end' } })
    expect(readBody(rec('ly","reply":"prose tail"}', 0, false, 3072), { pairedResultIsLiveOwner: true })).toMatchObject({ delivery: 'unknown', reply: { kind: 'damaged' } })
  })
})

describe('the v0.21.6 cut marker', () => {
  it('strips the v0.21.6 cut marker into cut and reads the rest as an excerpt', () => {
    const head = '[IMPORTANT: Background process proc_c1d2e3f4a5b6 completed normally (exit code 0).\nCommand: x\nOutput:\n'
    const parsed = parseSingleReceipt(`${head}...(first 2048 characters cut \u2014 process(action="log", session_id="proc_c1d2e3f4a5b6") has the full output)\nend of the reply]`)
    expect(parsed).toMatchObject({ cut: 2048, trimmed: false, body: 'end of the reply' })
    expect(readBody(parsed!, { pairedResultIsLiveOwner: false })).toMatchObject({ delivery: 'settled', reply: { kind: 'excerpt', body: 'end of the reply' } })
  })

  it('leaves cut null when the receipt carries no marker, and when the subagent trim marker took its place', () => {
    expect(parseSingleReceipt(receiptCli.text)).toMatchObject({ cut: null, trimmed: false })
    expect(parseSingleReceipt(receiptSubagentTrimmed.text)).toMatchObject({ cut: null, trimmed: true })
    expect(CUT_MARKER_RE.test('...(first 12 characters cut \u2014 process(action="log", session_id="proc_c1d2e3f4a5b6") has the full output)\n')).toBe(true)
  })
})

describe('PROCESS_TITLE_RE', () => {
  it('matches the one-line titles v0.21.6 sends in status.update {kind: "process"}', () => {
    for (const title of [
      'Background Process Finished: /opt/data/hermes/hermes-agent/venv/bin/python /opt/data/hermes/hermes-agent/tools/bot_mo...',
      'Background Process Failed (exit 1): python run.py',
      'Background Process Terminated: sleep 600',
      'Background Process Lost: tail -f log',
      'Background Process Failed to Start: missing-binary',
      'Background Process Finished',
    ]) {
      expect(PROCESS_TITLE_RE.test(title)).toBe(true)
    }
  })

  it('does not match a receipt, a batch title or a subagent title', () => {
    expect(PROCESS_TITLE_RE.test(receiptCli.text)).toBe(false)
    expect(PROCESS_TITLE_RE.test('2 Background Processes Finished')).toBe(false)
    expect(PROCESS_TITLE_RE.test('Subagent Task Completed: Ask Kevin for a slot')).toBe(false)
  })
})

describe('deliveryFromStatus / deliveryFromReason', () => {
  it('maps the full status vocabulary (spec 5.3, first table row)', () => {
    expect(deliveryFromStatus('sent')).toBe('admitted')
    expect(deliveryFromStatus('queued')).toBe('queued')
    expect(deliveryFromStatus('claimed')).toBe('claimed')
    expect(deliveryFromStatus('settled')).toBe('settled')
    expect(deliveryFromStatus('ambiguous')).toBe('unknown')
    expect(deliveryFromStatus('failed')).toBe('failed')
    expect(deliveryFromStatus('cancelled')).toBe('cancelled')
    expect(deliveryFromStatus('made_up_status')).toBe('unknown')
  })

  it('maps reasons to refused, failed, cancelled or unknown', () => {
    expect(deliveryFromReason('target_busy')).toBe('refused')
    expect(deliveryFromReason('provider_rate_limit')).toBe('failed')
    expect(deliveryFromReason('cancelled')).toBe('cancelled')
    expect(deliveryFromReason('made_up_code')).toBe('unknown')
    expect(deliveryFromReason(undefined)).toBe('unknown')
  })
})
