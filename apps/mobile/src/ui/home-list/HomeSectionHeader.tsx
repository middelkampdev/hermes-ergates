/**
 * A Home section heading in both modes (docs/10 "Home sections and pinned
 * members"): small grey section name with a chevron, down when expanded,
 * right when collapsed. The name area is the toggle in both modes; a
 * long-press, or the Edit section action for screen readers, opens the
 * Section page. The name keeps its place; only the ≡ column's static space
 * (`layoutEditing`) switches once per Edit toggle, not per frame, and the ≡
 * itself slides in from the right and fades in by transform and opacity
 * (the same arithmetic a row's ≡ uses, `row-offsets.ts`'s `handleOffset`).
 * The name area and the handle sit side by side, so the two gestures never
 * overlap; touching the handle switches the rows list to headers only
 * before the drag starts. Outside Edit mode a `hitSlop` extends the name
 * area's touch past the ≡ column's reserved page-padding strip, so the
 * whole header toggles collapse edge to edge.
 */

import { Pressable, StyleSheet, Text, View, type AccessibilityActionEvent } from 'react-native'
import Animated, { useAnimatedStyle, type SharedValue } from 'react-native-reanimated'
import Sortable from 'react-native-sortables'

import { EDIT_ITEM_HEIGHT, EDIT_SECTION_ACTION, type MoveAction, type SectionDragEvent } from '@/features/agents'
import { useTheme } from '@/theme/provider'
import { ICON_SIZE, RULE, SPACE, TYPE } from '@/theme/tokens'

import { Icon } from '../icons'
import { Grip } from './Grip'
import { HANDLE_WIDTH, handleOffset } from './row-offsets'

export interface HomeSectionHeaderProps {
  name: string
  expanded: boolean
  editing: boolean
  /** The static Edit-mode layout (the ≡ column reserved): on the instant Edit mode starts, off only once a leave has fully finished. */
  layoutEditing: boolean
  /** Edit mode's progress, 0 to 1. */
  progress: SharedValue<number>
  /** Move up and Move down, in Edit mode. */
  actions: MoveAction[]
  onAction(event: AccessibilityActionEvent): void
  onToggle(): void
  /** Opens the Section page (rename or delete). */
  onEdit(): void
  onHandle(event: SectionDragEvent): void
  sectionKey: string
  gutter: number
}

export function HomeSectionHeader({ name, expanded, editing, layoutEditing, progress, actions, onAction, onToggle, onEdit, onHandle, sectionKey, gutter }: HomeSectionHeaderProps) {
  const theme = useTheme()
  const handle = useAnimatedStyle(() => ({ opacity: progress.get(), transform: [{ translateX: handleOffset(progress.get(), gutter, layoutEditing) }] }))
  return (
    <View style={[styles.header, { backgroundColor: theme.colors.background }]}>
      <Pressable
        onPress={onToggle}
        onLongPress={onEdit}
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        accessibilityLabel={`${name} section`}
        accessibilityActions={[...(editing ? actions : []), EDIT_SECTION_ACTION]}
        onAccessibilityAction={onAction}
        hitSlop={editing ? undefined : { right: gutter }}
        style={[styles.name, { paddingLeft: gutter }]}
      >
        <Text numberOfLines={1} maxFontSizeMultiplier={RULE.maxFontScale} style={[styles.text, { color: theme.colors.mutedForeground }]}>
          {name}
        </Text>
        <Icon name={expanded ? 'chevron-down' : 'chevron-right'} size={ICON_SIZE.small} color={theme.colors.mutedForeground} />
      </Pressable>
      {/* A plain (not animated) width: it only ever takes one of two values, switched once per toggle by `layoutEditing`, never per frame. */}
      <View pointerEvents={editing ? 'auto' : 'none'} style={[styles.trailing, { width: gutter + (layoutEditing ? HANDLE_WIDTH : 0) }]}>
        <Animated.View style={[styles.fill, { width: gutter + HANDLE_WIDTH }, handle]}>
          <Sortable.Handle style={styles.fill}>
            {/* The touch area runs to the screen edge; the glyph stays in line with the rows' ≡. */}
            <Sortable.Touchable
              style={[styles.handleFill, { paddingRight: gutter }]}
              onTouchesDown={() => onHandle({ type: 'press', key: sectionKey })}
              onTouchesUp={() => onHandle({ type: 'release' })}
            >
              <Grip />
            </Sortable.Touchable>
          </Sortable.Handle>
        </Animated.View>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  header: { height: EDIT_ITEM_HEIGHT.section, flexDirection: 'row', alignItems: 'center' },
  name: { flex: 1, alignSelf: 'stretch', flexDirection: 'row', alignItems: 'center', gap: SPACE.extraSmall },
  text: { ...TYPE.footnote },
  trailing: { alignSelf: 'stretch', overflow: 'hidden', alignItems: 'flex-end' },
  fill: { flex: 1 },
  handleFill: { flex: 1, alignSelf: 'stretch', alignItems: 'flex-end', justifyContent: 'center' }
})
