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
 * text node a fresh measurement.
 *
 * Every mounted page remounts its content, including the pages under the
 * open one in the stack. State held inside that content resets: scroll
 * position, focus, expanded rows. Typed drafts live in the page component
 * above the key or in a store, so they stay; state that must survive and
 * lives inside the content is kept above the key (the chat's clarify
 * answers), and state that points into the old content is reset with
 * `useOnFontScaleChange` (an open action menu, the chat's jump button).
 */

import { useEffect, useRef } from 'react'
import { useWindowDimensions } from 'react-native'

export function useFontScaleKey(): string {
  return String(useWindowDimensions().fontScale)
}

/** Calls `onChange` after the system text size changes; not on the first render. */
export function useOnFontScaleChange(onChange: () => void): void {
  const key = useFontScaleKey()
  const last = useRef(key)
  const callback = useRef(onChange)
  callback.current = onChange
  useEffect(() => {
    if (last.current !== key) {
      last.current = key
      callback.current()
    }
  }, [key])
}
