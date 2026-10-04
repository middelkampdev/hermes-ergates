/**
 * The page's horizontal padding (docs/10 section 4): `SPACE.extraLarge`,
 * `SPACE.large` on narrow phones. `Screen` pads every page with it. A
 * full-bleed list (the Home lists) cancels it with `bleed` and pads each of
 * its own rows by the same amount instead, so a row's tap highlight, a lifted
 * row and the scroll bar reach the screen edges while the row content stays
 * in line with the rest of the page. `Sheet` pads its header and content by
 * `SPACE.extraLarge` too. Everything else (rows, section headings, the chat
 * list) sits inside an already-padded page and must not add the gutter again.
 */

import { RULE, SPACE } from '@/theme/tokens'

export function pagePadding(windowWidth: number): number {
  return windowWidth < RULE.narrowScreen ? SPACE.large : SPACE.extraLarge
}

/** The style that stretches a list inside `Screen` to the screen edges. */
export function bleed(padding: number): { marginHorizontal: number } {
  return { marginHorizontal: -padding }
}
