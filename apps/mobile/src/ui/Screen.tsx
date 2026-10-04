/**
 * Safe-area page wrapper (docs/10 section 4: page padding 20, 16 on narrow
 * devices). Applies the theme background to the whole safe area, and
 * horizontal page padding to its content.
 *
 * Never insets the bottom edge: content scrolls to the bottom of the phone,
 * and the screen's own scroll view or fixed bottom bar carries the safe-area
 * inset as padding instead (`useBottomInset`), so the last row can still
 * clear the home indicator instead of stopping in an empty reserved strip.
 * `edges` is filtered the same way, so a caller can never reintroduce the
 * strip by passing `'bottom'`.
 */

import type { ReactNode } from 'react'
import { StyleSheet, useWindowDimensions, View, type ViewStyle } from 'react-native'
import { SafeAreaView, type Edge } from 'react-native-safe-area-context'

import { useTheme } from '@/theme/provider'

import { pagePadding } from './page-padding'
import { useFontScaleKey } from './use-font-scale-key'

/** Default edges: top, left and right. Never bottom — see the module comment. */
const DEFAULT_EDGES: readonly Edge[] = ['top', 'left', 'right']

export interface ScreenProps {
  children: ReactNode
  /** Safe-area edges to inset. Default: top, left, right. `'bottom'` is always dropped. */
  edges?: readonly Edge[]
  style?: ViewStyle
}

/** The horizontal padding `Screen` gives this page; a full-bleed list pads its rows by it (see `page-padding.ts`). */
export function usePagePadding(): number {
  const theme = useTheme()
  const { width } = useWindowDimensions()
  return pagePadding(width, theme.pagePadding)
}

export function Screen({ children, edges, style }: ScreenProps) {
  const theme = useTheme()
  const horizontalPadding = usePagePadding()
  const fontScaleKey = useFontScaleKey()
  const resolvedEdges = (edges ?? DEFAULT_EDGES).filter(edge => edge !== 'bottom')

  return (
    <SafeAreaView
      edges={resolvedEdges}
      style={[styles.safeArea, { backgroundColor: theme.colors.background }]}
    >
      <View key={fontScaleKey} style={[styles.content, { paddingHorizontal: horizontalPadding }, style]}>
        {children}
      </View>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1
  },
  content: {
    flex: 1
  }
})
