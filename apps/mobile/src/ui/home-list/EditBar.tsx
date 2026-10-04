/**
 * The Home Edit mode bottom bar (docs/10 "Home edit mode"): Move to…,
 * Pin/Unpin, Hide and Mark read/Mark unread for every selected agent. It is
 * a fixed overlay at the bottom of Home, full width, that slides up as one
 * rigid piece by `translateY` when at least one agent is selected and down
 * when none is, with the Edit mode motion; nothing about it grows or
 * shrinks. `editBarHeight` gives its height so Home can reserve the same
 * amount of space at the end of the list while the bar is up. The labels
 * come from `editBarLabels`; the screen owns the effects.
 */

import { useRef } from 'react'
import { Pressable, StyleSheet, Text } from 'react-native'
import Animated, { useAnimatedStyle } from 'react-native-reanimated'

import type { EditBarLabels } from '@/features/agents'
import { useTheme } from '@/theme/provider'
import { LEGACY_OPACITY, TYPE, type MobileTheme } from '@/theme/tokens'

import { useBottomInset } from '../use-bottom-inset'
import { MAX_FONT_SCALE } from './HomeRow'
import { useShowProgress } from './motion'

const BAR_PADDING_TOP = 4

/** The bar's fixed height, its own bottom-safe-area padding included. */
export function editBarHeight(theme: MobileTheme, bottomInset: number): number {
  return StyleSheet.hairlineWidth + BAR_PADDING_TOP + theme.hit + bottomInset
}

export interface EditBarProps {
  labels: EditBarLabels
  /** At least one agent is selected in Edit mode. */
  shown: boolean
  onMove(): void
  onPin(): void
  onHide(): void
  onRead(): void
}

export function EditBar({ labels, shown, onMove, onPin, onHide, onRead }: EditBarProps) {
  const theme = useTheme()
  // A fixed bottom bar: it draws its background to the screen edge and pads
  // its own content by the inset, so the buttons sit above the home indicator.
  const bottomInset = useBottomInset()
  const height = editBarHeight(theme, bottomInset)
  const progress = useShowProgress(shown)
  const slide = useAnimatedStyle(() => ({ transform: [{ translateY: (1 - progress.get()) * height }] }))

  // While the bar slides away, it keeps the labels it had while it was still
  // shown, so Unpin does not flip back to Pin mid-slide.
  const lastShown = useRef(labels)
  if (shown) {
    lastShown.current = labels
  }
  const shownLabels = shown ? labels : lastShown.current

  const actions = [
    { key: 'move', label: 'Move to…', onPress: onMove },
    { key: 'pin', label: shownLabels.pin, onPress: onPin },
    { key: 'hide', label: 'Hide', onPress: onHide },
    { key: 'read', label: shownLabels.read, onPress: onRead }
  ]
  return (
    <Animated.View
      pointerEvents={shown ? 'auto' : 'none'}
      accessibilityElementsHidden={!shown}
      importantForAccessibility={shown ? 'auto' : 'no-hide-descendants'}
      style={[styles.frame, { height, paddingBottom: bottomInset, borderTopColor: theme.colors.border, backgroundColor: theme.colors.background }, slide]}
    >
      {actions.map(action => (
        <Pressable
          key={action.key}
          onPress={action.onPress}
          accessibilityRole="button"
          accessibilityLabel={action.label}
          style={({ pressed }) => [styles.action, { minHeight: theme.hit, opacity: pressed ? LEGACY_OPACITY.pressed : 1 }]}
        >
          <Text numberOfLines={1} maxFontSizeMultiplier={MAX_FONT_SCALE} style={[styles.label, { color: theme.colors.primary }]}>
            {action.label}
          </Text>
        </Pressable>
      ))}
    </Animated.View>
  )
}

const styles = StyleSheet.create({
  frame: { position: 'absolute', left: 0, right: 0, bottom: 0, flexDirection: 'row', borderTopWidth: StyleSheet.hairlineWidth, paddingTop: BAR_PADDING_TOP },
  action: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  label: { ...TYPE.calloutStrong }
})
