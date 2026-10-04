/**
 * The bottom safe-area padding rule (docs/10 section 4): content scrolls to
 * the bottom edge of the phone, so a scroll view never insets its own frame
 * there — its content container carries the device's bottom inset as
 * padding instead, on top of whatever bottom padding the screen already
 * wanted. A fixed bottom bar (no scrolling) uses the same rule with its own
 * padding as `base`, which is 0 when it had none before.
 *
 * While the keyboard is open, a keyboard-avoiding view (`padding` behavior)
 * or a scroll view's keyboard inset already moves the content up by the full
 * keyboard height, measured down to the physical bottom of the screen — the
 * inset is already covered by the keyboard. Adding it again here would leave an empty gap between the last
 * field and the keyboard, so it is dropped until the keyboard closes.
 */

export function bottomPadding(base: number, inset: number, keyboardOpen: boolean): number {
  return base + (keyboardOpen ? 0 : inset)
}
