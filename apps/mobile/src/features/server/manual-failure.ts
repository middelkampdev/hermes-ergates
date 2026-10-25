/**
 * The sentence that says why Hermes left an install to the user: the Finish
 * screen puts it above the command, and the Update screen says it when an
 * update ends by hand. Hermes's own text comes through on one line and cut to
 * a length that cannot fill the screen.
 */

import type { ManualFailure } from './setup-run'

/** Hermes's own text is cut here, as the gateway cuts it, so it cannot fill the screen. */
const MAX_DETAIL = 200

/**
 * White space and the characters that end a line or do not show: the control characters (U+0000 to U+001F and U+007F to U+009F, U+0085 among them) and the
 * line and paragraph separators. Written out, because the app's JavaScript engine may lack Unicode property escapes.
 */
const LINE_BREAKING = /[\s\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g
/** The characters that hide or reorder text: zero-width marks, the direction marks, and the bidirectional embeddings, overrides and isolates. */
const HIDING = /[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g

/** Hermes's text on one line and in the order it is written: a line break would let it put a line of its own beside the command, and a hidden or reordering character would let it show something else. */
function oneLine(text: string | null): string | null {
  const line = text?.replace(HIDING, '').replace(LINE_BREAKING, ' ').trim().slice(0, MAX_DETAIL).trim()
  return line ? line : null
}

export function failureLine(failure: ManualFailure, detail: string | null): string {
  switch (failure) {
    case 'scan_blocked':
      return "Hermes's security check stopped the install. Run the command to see the findings."
    case 'no_git':
      return 'Your server has no Git, which Hermes needs to install plugins. Install Git first.'
    case 'download_failed':
      return 'Your server could not download the plugin from GitHub.'
    case 'enable_refused':
      return refusalLine('Hermes refused to turn it on', detail)
    case 'refused':
      return refusalLine('Hermes refused the install', detail)
  }
}

function refusalLine(refusal: string, detail: string | null): string {
  const text = oneLine(detail)
  return text === null ? `${refusal}.` : `${refusal}: ${text}`
}
