/**
 * A Home conversation row in both modes (docs/10 "Home", "Home edit mode"):
 * avatar, name, role badge, time, one-line preview and unread dot, the same
 * look in and out of Edit mode. The ≡ column's static space (`layoutEditing`)
 * switches once per Edit toggle, not per frame: see `motion.ts`'s
 * `useLayoutEditing` and `row-offsets.ts`'s arithmetic for why the row still
 * looks like it slides smoothly across that one switch. Only transforms and
 * opacity animate: the row body slides right, the selection circle
 * (positioned absolutely over the leading page padding) slides in and fades
 * in, the time and the unread dot get their own extra slide so the ≡ never
 * draws over them, and the ≡ itself slides in from the right and fades in.
 * None of that costs a Yoga layout pass or a text remeasure per frame.
 *
 * The row runs edge to edge (`page-padding.ts`): its tap highlight spans the
 * whole width, the ≡ column too, and its content is padded by the page
 * padding. Outside Edit mode a `hitSlop` on the body extends its touch past
 * the ≡ column's reserved page-padding strip, so a tap there still opens the
 * chat; in Edit mode the ≡ column keeps its own touch, and the circle takes
 * over from the body for swipe to select (gated by `pointerEvents`, not by
 * rebuilding the gesture: see `swipeGesture` below). The row has a fixed
 * height (the section drag and swipe to select measure with it), so its
 * text grows with the system text size only up to 1.4 times, in both modes.
 *
 * The row's background is its own bottom layer, not its root's color: while
 * the lifted row is over the pinned avatars (`hovering`, from
 * `use-cross-drag.ts`) the layer fades out, so the avatars show through
 * the row, which the rows list fades at the same time.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { Pressable, StyleSheet, View, type AccessibilityActionEvent } from 'react-native'
import { GestureDetector } from 'react-native-gesture-handler'
import Animated, { useAnimatedStyle, type SharedValue } from 'react-native-reanimated'
import Sortable from 'react-native-sortables'

import { EDIT_ITEM_HEIGHT, editRowLabel, useAvatar, type Bot, type MoveAction } from '@/features/agents'
import { formatRowTime } from '@/lib/time'
import { useTheme } from '@/theme/provider'

import type { AnchorRect } from '../ActionMenu'
import { Avatar } from '../Avatar'
import { ROW_AVATAR_SIZE, RowContent } from '../RowContent'
import { Grip } from './Grip'
import { CIRCLE_COLUMN, HANDLE_WIDTH, handleOffset, rowOffsets } from './row-offsets'
import { SelectionCircle } from './SelectionCircle'
import type { SwipeSelect } from './use-swipe-select'

export const MAX_FONT_SCALE = 1.4

export interface HomeRowProps {
  bot: Bot
  gateway: Parameters<typeof useAvatar>[0]
  connectionId: string
  unread: boolean
  editing: boolean
  /** The static Edit-mode layout (the circle and the ≡ column reserved): on the instant Edit mode starts, off only once a leave has fully finished. */
  layoutEditing: boolean
  /** Edit mode's progress, 0 to 1. */
  progress: SharedValue<number>
  selected: boolean
  /** Move up and Move down, in Edit mode. */
  actions: MoveAction[]
  onAction(event: AccessibilityActionEvent): void
  /** Opens the chat, or toggles the selection in Edit mode. */
  onPress(): void
  /** The long-press menu, outside Edit mode; gets the row's window rectangle. */
  onLongPress(anchor: AnchorRect): void
  rowKey: string
  swipe: SwipeSelect
  gutter: number
  /** The key of the lifted row while it is over the pinned area, else null. */
  hovering: SharedValue<string | null>
}

export function HomeRow(props: HomeRowProps) {
  const { bot, gateway, connectionId, unread, editing, layoutEditing, progress, selected, actions, onAction, onPress, onLongPress, rowKey, swipe, gutter, hovering } = props
  const theme = useTheme()
  const avatar = useAvatar(gateway, connectionId, bot.profile, bot.hasAvatar)
  const ref = useRef<View>(null)
  // Gated by the circle's own `pointerEvents` below, not by rebuilding the
  // gesture: outside Edit mode no touch ever reaches it, so the gesture
  // object itself can stay enabled and does not need `editing` as a dep.
  const swipeGesture = useMemo(() => swipe.gestureFor(rowKey), [swipe, rowKey])
  useEffect(() => () => swipe.forget(rowKey), [swipe, rowKey])
  const [pressed, setPressed] = useState(false)

  const body = useAnimatedStyle(() => ({ transform: [{ translateX: rowOffsets(progress.get(), gutter, layoutEditing).body }] }))
  const timeDot = useAnimatedStyle(() => ({ transform: [{ translateX: rowOffsets(progress.get(), gutter, layoutEditing).timeDot }] }))
  const circle = useAnimatedStyle(() => ({ opacity: progress.get(), transform: [{ translateX: (progress.get() - 1) * CIRCLE_COLUMN }] }))
  const handle = useAnimatedStyle(() => ({ opacity: progress.get(), transform: [{ translateX: handleOffset(progress.get(), gutter, layoutEditing) }] }))
  const background = useAnimatedStyle(() => ({ opacity: hovering.get() === rowKey ? 0 : 1 }))

  const time = formatRowTime(bot.lastActivityAt)
  const preview = bot.preview || bot.description
  // The label ends in "selected" or "not selected" in Edit mode; a selected state would say it twice.
  const label = editing ? editRowLabel(bot, selected, unread) : [bot.name, bot.role, unread ? 'unread' : '', time, preview].filter(Boolean).join(', ')
  const measure = () => ref.current?.measureInWindow((x, y, width, height) => onLongPress({ x, y, width, height }))

  return (
    <View ref={ref} collapsable={false} style={styles.row}>
      <Animated.View pointerEvents="none" style={[styles.background, { backgroundColor: pressed ? theme.colors.muted : theme.colors.background }, background]} />
      <Pressable
        onPress={onPress}
        onLongPress={editing ? undefined : measure}
        onPressIn={() => setPressed(true)}
        onPressOut={() => setPressed(false)}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityActions={editing ? actions : []}
        onAccessibilityAction={onAction}
        hitSlop={editing ? undefined : { right: gutter }}
        style={styles.body}
      >
        <Animated.View style={[styles.bodyContent, { paddingLeft: gutter }, body]}>
          <RowContent
            name={bot.name}
            avatar={<Avatar name={bot.name} color={bot.color} imageUri={avatar.data ?? null} size={ROW_AVATAR_SIZE} />}
            role={bot.role}
            time={time}
            preview={preview}
            unread={unread}
            maxFontScale={MAX_FONT_SCALE}
            // Its own extra slide keeps the time, and the unread dot, from ever sitting under the incoming ≡ (row-offsets.ts).
            trailingStyle={timeDot}
          />
        </Animated.View>
        {/* The circle sits absolutely over the leading page padding and slides in from there; a touch that starts here belongs to swipe to select. */}
        <GestureDetector gesture={swipeGesture}>
          <Animated.View pointerEvents={editing ? 'auto' : 'none'} style={[styles.circleColumn, { width: gutter + CIRCLE_COLUMN, paddingLeft: gutter }, circle]}>
            <SelectionCircle selected={selected} />
          </Animated.View>
        </GestureDetector>
      </Pressable>
      {/* A plain (not animated) width: it only ever takes one of two values, switched once per toggle by `layoutEditing`, never per frame. */}
      <View pointerEvents={editing ? 'auto' : 'none'} style={[styles.trailing, { width: gutter + (layoutEditing ? CIRCLE_COLUMN + HANDLE_WIDTH : 0) }]}>
        <Animated.View style={[styles.fill, { width: gutter + HANDLE_WIDTH }, handle]}>
          {/* The drag gesture sits on the view `Sortable.Handle` wraps: it fills the ≡ column, so a touch anywhere on it picks the row up. */}
          <Sortable.Handle style={[styles.handle, { paddingRight: gutter }]}>
            <Grip />
          </Sortable.Handle>
        </Animated.View>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  row: { height: EDIT_ITEM_HEIGHT.row, flexDirection: 'row', alignItems: 'center' },
  background: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  body: { flex: 1, alignSelf: 'stretch', flexDirection: 'row', alignItems: 'center' },
  bodyContent: { flex: 1, flexDirection: 'row', alignItems: 'center' },
  circleColumn: { position: 'absolute', left: 0, top: 0, bottom: 0, justifyContent: 'center' },
  trailing: { alignSelf: 'stretch', overflow: 'hidden', alignItems: 'flex-end' },
  fill: { flex: 1 },
  handle: { flex: 1, alignItems: 'flex-end', justifyContent: 'center' }
})
