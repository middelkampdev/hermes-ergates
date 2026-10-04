/**
 * The drop skeleton under an empty section's header in Edit mode (docs/10
 * "Home edit mode"): a row-high dashed outline, inset by the page padding,
 * with "Drag agents here" in the middle. It is an item of the rows list
 * (the agents feature's `withSectionGhosts`), there while the static Edit
 * layout is (`layoutEditing`), and it fades in and out with Edit mode's
 * progress; a collapsed section gets none. It has no handle and takes no
 * touch: a row dropped right above or below it joins its section.
 */

import { StyleSheet, Text, View } from 'react-native'
import Animated, { useAnimatedStyle, type SharedValue } from 'react-native-reanimated'

import { EDIT_ITEM_HEIGHT } from '@/features/agents'
import { useTheme } from '@/theme/provider'
import { RADIUS, TYPE } from '@/theme/tokens'

import { MAX_FONT_SCALE } from './HomeRow'

/** The dashed outlines of both drop skeletons (this row and the empty pinned area) are `mutedForeground` at this strength, quieter than any text. */
export const SKELETON_RING_OPACITY = 0.45
/** How far the outline sits inside the row, top and bottom. */
const OUTLINE_INSET = 8
const OUTLINE_RADIUS = RADIUS.small

export function SectionGhostRow({ progress, gutter }: { progress: SharedValue<number>; gutter: number }) {
  const theme = useTheme()
  const fade = useAnimatedStyle(() => ({ opacity: progress.get() }))
  return (
    <Animated.View
      pointerEvents="none"
      accessible
      accessibilityLabel="Empty section. Drag agents here, or select agents and choose Move to."
      style={[styles.row, fade]}
    >
      <View style={[styles.outline, { left: gutter, right: gutter, borderColor: theme.colors.mutedForeground }]} />
      <Text numberOfLines={1} maxFontSizeMultiplier={MAX_FONT_SCALE} style={[styles.caption, { color: theme.colors.mutedForeground }]}>
        Drag agents here
      </Text>
    </Animated.View>
  )
}

const styles = StyleSheet.create({
  row: { height: EDIT_ITEM_HEIGHT.row, alignItems: 'center', justifyContent: 'center' },
  outline: {
    position: 'absolute',
    top: OUTLINE_INSET,
    bottom: OUTLINE_INSET,
    borderWidth: 1.5,
    borderStyle: 'dashed',
    borderRadius: OUTLINE_RADIUS,
    opacity: SKELETON_RING_OPACITY
  },
  caption: { ...TYPE.callout }
})
