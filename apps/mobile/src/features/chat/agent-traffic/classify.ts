/**
 * Row classification for bot-to-bot traffic in chat.
 * Pure: no React or React Native imports (ADR-029 rule 1).
 */

import { parseReceiptRow, type ParsedReceipt } from './receipt'

export const A2A_DISPLAY_KIND = 'a2a_message'

/**
 * The receipt row Hermes v0.21.6 writes when a background process finishes: the content is the
 * whole `[IMPORTANT: …]` receipt and `display_metadata.display_text` a one-line title
 * (tui_gateway/session_notifications.py:598-602; tools/bot_mode_dm.py:788-792).
 */
export const PROCESS_COMPLETE_DISPLAY_KIND = 'process_complete'

/**
 * Desktop's accepted inbound shapes, verbatim from Hermes v0.21.6
 * (apps/desktop/src/components/assistant-ui/thread/user-message.tsx:94-95). A relayed sender is
 * stamped `(@<handle>@<connection>)` (tools/bot_relay.py:240-255); the handle group stops before
 * the connection.
 */
export const AGENT_MESSAGE_RE =
  /^(?:Message from (?:🤖\s*)?([^:\n(]{1,64}?)(?:\s*\(@([a-z0-9][a-z0-9_-]{0,63})(?:@[a-zA-Z0-9][a-zA-Z0-9_-]{0,63})?\))?:\s*|\[Message from agent '([^']{1,64})'\]\s*)([\s\S]*)$/u

export type RowClass =
  | { kind: 'bot_message'; handle: string; name: string; text: string; provenance: 'structured' | 'inferred'; senderId?: string; deliveryId?: string }
  | { kind: 'receipts'; receipts: ParsedReceipt[] }
  | { kind: 'notice'; noticeKind: 'process' | 'batch' | 'unknown'; detail: string }
  | { kind: 'plain' }

type BotMessage = Extract<RowClass, { kind: 'bot_message' }>

/**
 * Step 1a: a validated `a2a_message` stamp. Returns undefined when the metadata does not carry a
 * `sender_handle`. The backend keeps the human-facing "Message from ..." prefix on the content even
 * when a stamp exists (spec section 2, `tools/bot_mode_dm.py:215`), so the prefix is stripped here
 * when present; the raw text is used otherwise.
 */
function structuredBotMessage(text: string, metadata: unknown): BotMessage | undefined {
  if (typeof metadata !== 'object' || metadata === null) return undefined
  const m = metadata as Record<string, unknown>
  if (typeof m.sender_handle !== 'string') return undefined

  const match = AGENT_MESSAGE_RE.exec(text)
  const body = match ? (match[4] ?? '') : text

  const message: BotMessage = { kind: 'bot_message', handle: m.sender_handle, name: m.sender_handle, text: body, provenance: 'structured' }
  if (typeof m.sender_id === 'string') message.senderId = m.sender_id
  if (typeof m.delivery_id === 'string') message.deliveryId = m.delivery_id
  return message
}

/** Step 3: the legacy inferred shapes, matched only on rows without a `localId`. */
function inferredBotMessage(text: string): BotMessage | undefined {
  const match = AGENT_MESSAGE_RE.exec(text)
  if (!match) return undefined
  const name = (match[1] ?? match[3])!.trim()
  const handle = (match[2] ?? name).trim().toLowerCase()
  return { kind: 'bot_message', handle, name, text: match[4] ?? '', provenance: 'inferred' }
}

/**
 * A `process_complete` row is a process result on Desktop, never the human speaking: it hydrates
 * as a system notice (apps/desktop/src/lib/chat-messages/hydration.ts:159-175, :452, :603-606). Its
 * content is read with the receipt grammar only; text that does not parse is a process notice.
 */
function processCompleteRow(text: string): RowClass {
  const receiptParse = parseReceiptRow(text)
  if (receiptParse.kind === 'receipts') return { kind: 'receipts', receipts: receiptParse.receipts }
  return { kind: 'notice', noticeKind: receiptParse.kind === 'notice' ? receiptParse.noticeKind : 'process', detail: text }
}

/** Classifies a `user`-role chat row per the ordered rules of spec 5.1/5.6. */
export function classifyUserRow(row: { text: string; displayKind?: string; displayMetadata?: unknown; localId?: string }): RowClass {
  if (row.displayKind !== undefined) {
    if (row.displayKind === A2A_DISPLAY_KIND) return structuredBotMessage(row.text, row.displayMetadata) ?? { kind: 'plain' }
    if (row.displayKind === PROCESS_COMPLETE_DISPLAY_KIND) return processCompleteRow(row.text)
    return { kind: 'plain' } // any other known display kind is today's projection: plain.
  }

  const receiptParse = parseReceiptRow(row.text)
  if (receiptParse.kind === 'receipts') return { kind: 'receipts', receipts: receiptParse.receipts }
  if (receiptParse.kind === 'notice') return { kind: 'notice', noticeKind: receiptParse.noticeKind, detail: row.text }

  if (row.localId !== undefined) return { kind: 'plain' }

  return inferredBotMessage(row.text) ?? { kind: 'plain' }
}
