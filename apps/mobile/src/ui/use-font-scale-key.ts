/**
 * A React key that changes when the system text size changes, for the root
 * of a page's content.
 *
 * When the text size changes while the app runs, React Native (iOS, new
 * architecture) re-measures every text node, but the next React render
 * reuses React's own copies of the text nodes it did not change, and those
 * still hold the old measurement. The text is then drawn at the new size
 * inside its old box: clipped when the text grew, floating in an oversized
 * row when it shrank. Remounting the page content on that change gives every
 * text node a fresh measurement. Only the content's local state (scroll
 * position, focus) resets, and only on a text-size change.
 */

import { useWindowDimensions } from 'react-native'

export function useFontScaleKey(): string {
  return String(useWindowDimensions().fontScale)
}
