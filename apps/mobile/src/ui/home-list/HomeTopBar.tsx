/**
 * Home's top bar (docs/10 "Home", "Home edit mode"). Outside Edit mode:
 * Settings at left; Edit (a text button on iOS, an icon on Android), Search
 * and Add at right. In Edit mode: Done on the left and "N selected" in the
 * middle on iOS; ✕ on the left and "N selected" as the title on Android.
 * The two cross-fade with Edit mode's progress; only the one shown takes
 * touches and screen-reader focus.
 */

import { Platform, StyleSheet, Text, View } from 'react-native'
import Animated, { useAnimatedStyle, type SharedValue } from 'react-native-reanimated'

import { selectionTitle } from '@/features/agents'
import { useTheme } from '@/theme/provider'
import { SIZE, SPACE, TYPE } from '@/theme/tokens'

import { Button } from '../Button'
import { IconButton } from '../IconButton'

export interface HomeTopBarProps {
  editing: boolean
  /** Edit mode's progress, 0 to 1. */
  progress: SharedValue<number>
  selectedCount: number
  onSettings(): void
  onEdit(): void
  onDone(): void
  onSearch(): void
  onAdd(): void
}

/** Screen-reader visibility of a layer: only the layer shown is read. */
const readable = (shown: boolean) => ({ accessibilityElementsHidden: !shown, importantForAccessibility: shown ? ('auto' as const) : ('no-hide-descendants' as const) })

export function HomeTopBar({ editing, progress, selectedCount, onSettings, onEdit, onDone, onSearch, onAdd }: HomeTopBarProps) {
  const theme = useTheme()
  const normal = useAnimatedStyle(() => ({ opacity: 1 - progress.get() }))
  const edit = useAnimatedStyle(() => ({ opacity: progress.get() }))
  const ios = Platform.OS === 'ios'
  const title = (
    <Text accessibilityRole="header" style={[styles.title, { color: theme.colors.foreground }]}>
      {selectionTitle(selectedCount)}
    </Text>
  )
  return (
    <View style={styles.bar}>
      <Animated.View pointerEvents={editing ? 'none' : 'auto'} style={[styles.layer, normal]} {...readable(!editing)}>
        <IconButton name="user" accessibilityLabel="Settings" onPress={onSettings} />
        <View style={styles.spacer} />
        {ios ? <Button label="Edit" variant="ghost" compact onPress={onEdit} /> : <IconButton name="edit-2" accessibilityLabel="Edit" onPress={onEdit} />}
        <IconButton name="search" accessibilityLabel="Search" onPress={onSearch} />
        <IconButton name="plus" accessibilityLabel="Add" onPress={onAdd} />
      </Animated.View>
      <Animated.View pointerEvents={editing ? 'box-none' : 'none'} style={[StyleSheet.absoluteFill, styles.layer, edit]} {...readable(editing)}>
        {ios ? (
          <>
            <View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.centered]}>
              {title}
            </View>
            <Button label="Done" variant="ghost" compact onPress={onDone} />
          </>
        ) : (
          <>
            <IconButton name="x" accessibilityLabel="Leave edit mode" onPress={onDone} />
            {title}
          </>
        )}
      </Animated.View>
    </View>
  )
}

const styles = StyleSheet.create({
  bar: { minHeight: SIZE.large, marginBottom: SPACE.medium, justifyContent: 'center' },
  layer: { flexDirection: 'row', alignItems: 'center', gap: SPACE.small, minHeight: SIZE.large },
  spacer: { flex: 1 },
  centered: { alignItems: 'center', justifyContent: 'center' },
  title: { ...TYPE.headline }
})
