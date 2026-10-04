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
import { OPACITY, RADIUS, RULE, SPACE, TYPE } from '@/theme/tokens'

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
      <Text numberOfLines={1} maxFontSizeMultiplier={RULE.maxFontScale} style={[styles.caption, { color: theme.colors.mutedForeground }]}>
        Drag agents here
      </Text>
    </Animated.View>
  )
}

const styles = StyleSheet.create({
  row: { height: EDIT_ITEM_HEIGHT.row, alignItems: 'center', justifyContent: 'center' },
  outline: {
    position: 'absolute',
    top: SPACE.small,
    bottom: SPACE.small,
    borderWidth: 1.5,
    borderStyle: 'dashed',
    borderRadius: RADIUS.medium,
    // Both drop skeletons (this row and the empty pinned area) draw their dashed outline at this strength, quieter than any text.
    opacity: OPACITY.medium
  },
  caption: { ...TYPE.callout }
})
