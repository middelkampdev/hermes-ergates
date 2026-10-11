import { describe, expect, it } from 'vitest'

import { classifyUserRow, PROCESS_COMPLETE_DISPLAY_KIND } from './classify'

import receiptBatchTwo from '@test/fixtures/agent-traffic/receipt-batch-two.json'
import receiptCli from '@test/fixtures/agent-traffic/receipt-cli.json'
import liveJson from '@test/fixtures/agent-traffic/receipt-live-json.json'

/** The one-line title v0.21.6 stores in a process_complete row's display_metadata (process_registry_notifications.py:335-349). */
const TITLE = 'Background Process Finished: /opt/data/hermes/hermes-agent/venv/bin/python /opt/data/hermes/hermes-agent/tools/bot_mo...'

describe('classifyUserRow', () => {
  it('prefers a validated a2a_message stamp, falling through to plain when metadata is invalid', () => {
    expect(
      classifyUserRow({
        text: 'Message from 🤖 kevin (@kevin): hi',
        displayKind: 'a2a_message',
        displayMetadata: { sender_handle: 'kevin', sender_id: 'bot:kevin', delivery_id: 'd1' },
      })
    ).toMatchObject({ kind: 'bot_message', handle: 'kevin', text: 'hi', provenance: 'structured', senderId: 'bot:kevin', deliveryId: 'd1' })
    expect(classifyUserRow({ text: 'x', displayKind: 'a2a_message', displayMetadata: { nope: 1 } })).toEqual({ kind: 'plain' })
  })

  it('strips the human-facing "Message from" prefix from a structured stamp, and leaves an unprefixed body untouched', () => {
    expect(
      classifyUserRow({
        text: 'Message from 🤖 kevin (@kevin): hi',
        displayKind: 'a2a_message',
        displayMetadata: { sender_handle: 'kevin' },
      })
    ).toMatchObject({ kind: 'bot_message', text: 'hi' })
    expect(
      classifyUserRow({ text: 'plain body', displayKind: 'a2a_message', displayMetadata: { sender_handle: 'kevin' } })
    ).toMatchObject({ kind: 'bot_message', text: 'plain body' })
  })

  it('omits senderId and deliveryId when the stamp does not carry them', () => {
    expect(classifyUserRow({ text: 'hi', displayKind: 'a2a_message', displayMetadata: { sender_handle: 'kevin' } })).toEqual({
      kind: 'bot_message',
      handle: 'kevin',
      name: 'kevin',
      text: 'hi',
      provenance: 'structured',
    })
  })

  it('classifies receipts before legacy shapes and keeps other known display kinds plain', () => {
    expect(classifyUserRow({ text: liveJson.text }).kind).toBe('receipts')
    expect(classifyUserRow({ text: 'Message from 🤖 kevin (@kevin): hi', displayKind: 'model_switch' })).toEqual({ kind: 'plain' })
  })

  it('classifies malformed receipt-shaped text as a notice carrying the raw text as detail', () => {
    const text = '[IMPORTANT: Background process proc_deadbeef0000 not a real receipt'
    expect(classifyUserRow({ text })).toEqual({ kind: 'notice', noticeKind: 'process', detail: text })
  })

  it('accepts exactly the three legacy shapes on rows without a localId', () => {
    expect(classifyUserRow({ text: 'Message from 🤖 hermes (@hermes): When are you free?' })).toMatchObject({
      kind: 'bot_message',
      handle: 'hermes',
      name: 'hermes',
      text: 'When are you free?',
      provenance: 'inferred',
    })
    expect(classifyUserRow({ text: 'Message from Kevin: hi' })).toMatchObject({ kind: 'bot_message', handle: 'kevin', name: 'Kevin', text: 'hi' })
    expect(classifyUserRow({ text: "[Message from agent 'Kevin'] hi" })).toMatchObject({ kind: 'bot_message', handle: 'kevin', text: 'hi' })
    expect(classifyUserRow({ text: 'Message from 🤖 kevin (@kevin): hi', localId: 'l1' })).toEqual({ kind: 'plain' })
    expect(classifyUserRow({ text: 'Tell me about Message from Kevin: no' })).toEqual({ kind: 'plain' })
  })

  it('reads a process_complete row with the receipt grammar', () => {
    expect(classifyUserRow({ text: receiptCli.text, displayKind: 'process_complete', displayMetadata: { display_text: TITLE } }))
      .toMatchObject({ kind: 'receipts', receipts: [{ headline: { processId: 'proc_782bd84d7f2a' } }] })
    expect(PROCESS_COMPLETE_DISPLAY_KIND).toBe('process_complete')
  })

  it('reads a process_complete batch row as one receipt per process, and never as a bot message or a plain bubble', () => {
    expect(classifyUserRow({ text: receiptBatchTwo.text, displayKind: 'process_complete', displayMetadata: { display_text: '2 Background Processes Finished' } }))
      .toMatchObject({ kind: 'receipts', receipts: [{ headline: { processId: 'proc_69dec248dc4e' } }, { headline: { processId: 'proc_8a312511b81e' } }] })
    const malformed = '[IMPORTANT: Background process proc_deadbeef0000 not a real receipt'
    expect(classifyUserRow({ text: malformed, displayKind: 'process_complete' })).toEqual({ kind: 'notice', noticeKind: 'process', detail: malformed })
    const unexpected = 'Message from 🤖 kevin (@kevin): hi'
    expect(classifyUserRow({ text: unexpected, displayKind: 'process_complete' })).toEqual({ kind: 'notice', noticeKind: 'process', detail: unexpected })
  })

  it('accepts a relayed sender stamp that names a connection', () => {
    expect(classifyUserRow({ text: 'Message from 🤖 kevin (@kevin@laptop): Tuesday works.' })).toMatchObject({ kind: 'bot_message', handle: 'kevin', text: 'Tuesday works.' })
  })

  it('treats near-miss legacy shapes as plain under the verbatim regex', () => {
    // Uppercase inside the (@handle) group: AGENT_MESSAGE_RE's handle class is [a-z0-9] only.
    expect(classifyUserRow({ text: 'Message from 🤖 Kevin (@KEVIN): hi' })).toEqual({ kind: 'plain' })
    // A name containing a literal '(' that isn't the (@handle) form.
    expect(classifyUserRow({ text: 'Message from Kevin (Ops): hi' })).toEqual({ kind: 'plain' })
  })
})
