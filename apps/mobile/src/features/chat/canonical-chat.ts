/**
 * Canonical Bot Chat resolution (docs/06 section 6; desktop canonical-chat.ts).
 *
 * Identity is (profile, "Bot Chat"), resolved by title on the server. The
 * roster's `canonical_session` pointer wins; the exact-title lookup is the
 * fallback; creation happens only when both say there is no chat. A failed
 * or unconfirmed lookup fails closed — it never mints a second chat.
 *
 * Four ways a forever chat forks, all closed here:
 *  1. a thrown registry lookup read as "no chat exists" (`lookup === null`)
 *  2. an empty lookup while the roster still names a canonical session
 *     (unconfirmed absence, hermes-agent#98383)
 *  3. the untitled window after `session.create` — the stored row does not
 *     exist until the first turn ends, so the eager `session.title` write
 *     materializes it and claims the title now
 *  4. a title-uniqueness rejection: another writer took the title between our
 *     miss and our write, so adopt the winner instead of prompting into our
 *     own stray session
 */

import { isGatewayError } from '@/gateway/errors'
import { BOT_CHAT_TITLE, type GatewayPort } from '@/gateway/port'
import type { HistoryMessage, ProfileSummary, SessionRow } from '@/gateway/types'

import type { ResumeSnapshot } from './session-reducer'

export { BOT_CHAT_TITLE }
export const PROFILE_SESSION_LIST_LIMIT = 200

export type CanonicalDecision = { action: 'resume'; storedId: string } | { action: 'create' }

export function isCanonicalRow(row: SessionRow): boolean {
  return row.title === BOT_CHAT_TITLE
}

/**
 * Pure decision. `lookup` is the result of the exact-title `session.list`,
 * or `null` when that lookup failed (fail closed).
 */
export function decideCanonical(profile: ProfileSummary | undefined, lookup: SessionRow[] | null): CanonicalDecision {
  const pointer = profile?.canonical_session
  if (pointer && (pointer.resolved_id || pointer.id)) {
    return { action: 'resume', storedId: pointer.resolved_id || pointer.id }
  }
  if (lookup === null) {
    throw new Error('Could not check the Bot Chat registry; not starting a new chat.')
  }
  const row = lookup.find(isCanonicalRow)
  if (row) {
    return { action: 'resume', storedId: row.resolved_id || row.id }
  }
  // A zero-row answer is not the same as a thrown error, but it forks the chat
  // just as effectively: a profile backend mid-restart answers `session.list`
  // successfully with an empty list, and `|| null` used to read that exactly like
  // "this bot never had a chat" (hermes-agent#98383). The roster reporting a
  // `canonical_session` at all is positive confirmation that this profile HAS
  // one, so an empty lookup next to it is unconfirmed absence — fail closed.
  // (`canonical_session: null` is how the backend says there is none.)
  if (pointer) {
    throw new Error('Could not confirm the Bot Chat registry; not starting a new chat.')
  }
  return { action: 'create' }
}

export interface OpenedChat {
  liveSessionId: string
  storedSessionId: string
  messages: HistoryMessage[]
  running: boolean
  created: boolean
  /** What `session.resume` said about the session being idle and the requests still open; `null` for a chat we just minted (spec 12.3). */
  snapshot: ResumeSnapshot | null
}

/** A title write rejected because another writer holds the canonical title. */
function isTitleConflict(err: unknown): boolean {
  if (/already in use/i.test(String((err as { message?: string })?.message ?? ''))) {
    return true
  }
  // `set_session_title` raises ValueError on a title collision; the gateway maps
  // that to 4022 (tui_gateway/methods_session.py:1006).
  return isGatewayError(err) && err.code === 4022
}

async function lookupCanonical(port: GatewayPort, profile: string): Promise<SessionRow[] | null> {
  try {
    const res = await port.sessions.list({ profile, title: BOT_CHAT_TITLE, limit: PROFILE_SESSION_LIST_LIMIT, include_hidden: true })
    return res.sessions ?? []
  } catch {
    return null
  }
}

async function resumeStored(port: GatewayPort, profile: string, storedId: string): Promise<OpenedChat> {
  const r = await port.sessions.resume({ session_id: storedId, profile })
  return {
    liveSessionId: r.session_id,
    storedSessionId: r.session_key || storedId,
    messages: r.messages ?? [],
    running: Boolean(r.running),
    created: false,
    snapshot: { status: r.status, running: Boolean(r.running), inflight: r.inflight ?? null, hydrating: r.hydrating, auto_continue: r.auto_continue, open_requests: r.open_requests }
  }
}

/** Resolve and open the canonical chat for `profile` through the port. */
export async function openCanonicalChat(port: GatewayPort, profile: string, summary?: ProfileSummary): Promise<OpenedChat> {
  const lookup = summary?.canonical_session?.id ? null : await lookupCanonical(port, profile)
  const decision = decideCanonical(summary, lookup)
  if (decision.action === 'resume') {
    return resumeStored(port, profile, decision.storedId)
  }

  const created = await port.sessions.create({
    title: BOT_CHAT_TITLE,
    profile,
    hidden: true,
    // Explicit contract (PR #97008): this session's runtime always follows the
    // member profile's CURRENT config, so a model change in the editor is not
    // undone by the model/provider pinned on the stored row.
    follow_profile_config: true
  })

  // `session.create` is lazy: the row is written at the END of the first turn,
  // so until this write lands the registry has no "Bot Chat" entry and a second
  // open mints a duplicate. It also stops the pruner reaping the empty session.
  try {
    await port.sessions.title(created.session_id, BOT_CHAT_TITLE)
  } catch (err) {
    if (!isTitleConflict(err)) {
      // An older gateway without `session.title`: keep the freshly created
      // session. The first prompt persists the row, as it always did.
      return { liveSessionId: created.session_id, storedSessionId: created.stored_session_id, messages: created.messages ?? [], running: false, created: true, snapshot: null }
    }
    // ADOPT-BEFORE-MINT: someone else took the canonical title between our
    // registry miss and this write. Re-consult the registry and adopt the
    // winner; our stray lazy session holds zero messages and is pruned.
    const winner = (await lookupCanonical(port, profile))?.find(isCanonicalRow)
    if (!winner) {
      throw new Error('Another Bot Chat already holds this title and it could not be read; not starting a new chat.')
    }
    return resumeStored(port, profile, winner.resolved_id || winner.id)
  }

  return { liveSessionId: created.session_id, storedSessionId: created.stored_session_id, messages: created.messages ?? [], running: false, created: true, snapshot: null }
}
