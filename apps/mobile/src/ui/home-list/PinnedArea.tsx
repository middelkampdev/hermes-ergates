/**
 * The pinned avatars at the top of Home, in both modes (docs/10 "Home",
 * "Home edit mode"): large avatars in pin order, wrapped and centered. With
 * Edit mode's progress each avatar gets a selection badge at its top left and
 * a move handle at its top right; the unread dot moves down to the bottom
 * right, clear of both. A tap toggles the selection in Edit mode; the move
 * handle drags the avatar left and right inside the pinned area, across
 * wrapped lines. Screen readers get Move left and Move right instead.
 *
 * The selection badge also carries swipe to select (the agents feature's
 * `swipe-select.ts`, `use-swipe-select.ts`'s `usePinSwipeSelect`): a touch
 * that starts there and moves selects or deselects a range of pins, the same
 * iOS Mail rule the rows list uses, in pin order across wrapped lines. The
 * pins are not measured one by one for this — each pin sits inside a
 * react-native-sortables item wrapper, so its own `onLayout` would report a
 * position relative to that wrapper, not to the pinned area. Instead
 * `pinCells` computes every pin's cell the way this `Sortable.Flex` itself
 * lays them out (`PIN_WIDTH`, `PIN_GAP`, `PIN_CELL_HEIGHT`, `PIN_PADDING_TOP`
 * and `gutter`, below), from the pins' own key order, so it stays right
 * after a pin drag reorders them; the one thing it cannot know ahead of
 * time, the pinned area's own width, comes from one `onLayout` on this
 * file's outer `View`. `BADGE_OFFSET` is the badge's own fixed position
 * inside a cell, used to seed the swipe at the touch's real spot. This is
 * also why the badge needs react-native-gesture-handler (`GestureDetector`):
 * see the dependency-cruiser rule this file is named in.
 *
 * With nothing pinned, Edit mode shows a drop skeleton in the pinned area's
 * place (`PinnedSkeleton`): three dashed ghost avatars where real pins would
 * sit and "Drag an agent here to pin it" under them, as high as one line of
 * pins. It is there while the static Edit layout is (`layoutEditing`) and
 * fades in and out with Edit mode's progress; outside Edit mode an empty
 * pinned area draws nothing, as before.
 *
 * A pin dragged by its move handle and dropped over the rows list is
 * unpinned there, and a row dragged over this area is pinned at the slot
 * under the finger (`use-cross-drag.ts`): the outer view carries the
 * measured `pinnedRef`, `PinsMarker` (or the skeleton's middle ghost avatar)
 * marks the slot, and `onDragEnd` asks `cross.end` before its own drop. The
 * whole area sits in a `Sortable.Layer`: the pins' own drag layer only
 * raises the pins above each other, inside this area, and a pin dragged out
 * over the rows list must draw above them too, so the layer raises the whole
 * area above its later sibling, the rows list, while a pin is dragged.
 */

import { useCallback, useEffect, useMemo, useRef } from 'react'
import { Pressable, StyleSheet, Text, View, type AccessibilityActionEvent } from 'react-native'
import { GestureDetector } from 'react-native-gesture-handler'
import Animated, { useAnimatedStyle, type AnimatedRef, type SharedValue } from 'react-native-reanimated'
import Sortable, { type DragMoveParams, type DragStartParams, type SortableFlexDragEndParams } from 'react-native-sortables'

import {
  editRowLabel,
  moveActions,
  moveDirection,
  moveStep,
  pinDropMove,
  sortableChildKey,
  useAvatar,
  type Bot,
  type CrossSlot,
  type EditItem,
  type PinAreaLayout,
  type PinnedItem,
  type Selection
} from '@/features/agents'
import { lightTap } from '@/lib/haptics'
import type { OrderMove } from '@/state/organization'
import { useTheme } from '@/theme/provider'
import { OPACITY, RULE, SIZE, SPACE, TYPE } from '@/theme/tokens'

import type { AnchorRect } from '../ActionMenu'
import { Avatar } from '../Avatar'
import { PinsMarker } from './CrossMarkers'
import { Grip } from './Grip'
import { SelectionCircle } from './SelectionCircle'
import type { CrossDrag } from './use-cross-drag'
import { usePinSwipeSelect, type PinSwipeSelect } from './use-swipe-select'

const AVATAR_SIZE = SIZE.giant
/** A pin's own column width; `pinCells`, swipe to select and the drag between the pins and the rows list measure with it. */
const PIN_WIDTH = 96
const PIN_GAP = SPACE.huge
/** The `Sortable.Flex`'s own `paddingVertical`, above the first line of pins. */
const PIN_PADDING_TOP = SPACE.extraLarge
/**
 * A pin's own column height: the avatar (`AVATAR_SIZE`), the gap under it
 * (`styles.pin`'s `gap`, `SPACE.small`), and one line of its name at the
 * default text size (18 pt, measured) — 114 pt. `pinCells` uses this fixed
 * height rather than measuring each pin, so it goes stale if the label ever
 * grows past one line at a larger accessibility text size;
 * `styles.label`'s `numberOfLines={1}` keeps it to one line regardless.
 */
const PIN_CELL_HEIGHT = AVATAR_SIZE + SPACE.small + 18
/**
 * The empty pinned area's drop skeleton in Edit mode is exactly one line of
 * pins high (154 pt), so the list below does not move when the last pin
 * leaves or the first one arrives. `HomeList` slides the rows by it while
 * Edit mode starts and ends.
 */
export const PINNED_SKELETON_HEIGHT = 2 * PIN_PADDING_TOP + PIN_CELL_HEIGHT
/** The ghost avatars of the skeleton, spaced like real pins: their centers `PIN_WIDTH + PIN_GAP` apart. */
const SKELETON_PINS = [0, 1, 2]
const SKELETON_PIN_GAP = PIN_WIDTH + PIN_GAP - AVATAR_SIZE
/** The ghost avatar that turns `primary` while a dragged row is over the skeleton: the one a first pin lands on, in the middle. */
const SKELETON_MIDDLE = 1
const BADGE_SIZE = SIZE.small
/** The ≡ glyph inside the move badge: 7/12 of the badge, so it keeps the same proportion inside its circle. */
const MOVE_GRIP_SIZE = Math.round((BADGE_SIZE * 7) / 12)
/**
 * How far the unread dot moves down, from its normal-mode spot near the top
 * to clear of the selection badge and the move handle: it ends as far above
 * the avatar's bottom as it starts below its top.
 */
const DOT_DROP = AVATAR_SIZE - SIZE.tiny - 2 * SPACE.hairline

/**
 * Badges at the avatar's square corners would crowd the next pin's badge,
 * so each one centers on the avatar's round edge at 45° instead. The avatar is a circle of radius `AVATAR_RADIUS`, centered at
 * (`AVATAR_CENTER_X`, `AVATAR_CENTER_Y`) in the column (`styles.pin` centers
 * it there, top-aligned, so its top edge is the column's own origin). A
 * point on the circle at 45° is the center offset by `radius · cos45°` on
 * one axis and `radius · sin45°` on the other; `Math.SQRT1_2` is cos45° (=
 * sin45°). The selection badge centers on the top-left point, the move
 * badge on the top-right one.
 */
const AVATAR_RADIUS = AVATAR_SIZE / 2
const AVATAR_CENTER_X = PIN_WIDTH / 2
const AVATAR_CENTER_Y = AVATAR_RADIUS
const CORNER_OFFSET = AVATAR_RADIUS * Math.SQRT1_2
const BADGE_CENTER_Y = AVATAR_CENTER_Y - CORNER_OFFSET
const SELECTION_CENTER_X = AVATAR_CENTER_X - CORNER_OFFSET
const MOVE_CENTER_X = AVATAR_CENTER_X + CORNER_OFFSET

/**
 * The selection badge's own top left, inside its pin's cell: fixed, because
 * it comes only from the avatar geometry above, never from the label's
 * height. Swipe to select uses it to turn a touch on the badge into a point
 * in the pinned area (`usePinSwipeSelect`'s `badgeOffset`).
 */
const BADGE_OFFSET = { x: SELECTION_CENTER_X - BADGE_SIZE / 2, y: BADGE_CENTER_Y - BADGE_SIZE / 2 }

/** The pinned area's own fixed geometry for `pinCells`, at page gutter `gutter`: everything but its width, which only a measurement gives. */
export function pinAreaGeometry(gutter: number): Omit<PinAreaLayout, 'width'> {
  return { gutter, cellWidth: PIN_WIDTH, cellHeight: PIN_CELL_HEIGHT, gap: PIN_GAP, paddingTop: PIN_PADDING_TOP }
}

export interface PinnedAreaProps {
  pins: PinnedItem[]
  /** The whole Home list, for Move left and Move right. */
  items: EditItem[]
  editing: boolean
  /** The static Edit-mode layout (`useLayoutEditing`): while it is on and nothing is pinned, the drop skeleton shows. */
  layoutEditing: boolean
  /** Edit mode's progress, 0 to 1. */
  progress: SharedValue<number>
  selection: Selection
  gateway: Parameters<typeof useAvatar>[0]
  connectionId: string
  /** The owner's Haptics setting: a light tap when a drag starts and when it drops. */
  haptics: boolean
  scrollRef: AnimatedRef<Animated.ScrollView>
  unread(profile: string): boolean
  /** Opens the chat, or toggles the selection in Edit mode. */
  onPress(bot: Bot): void
  onLongPress(bot: Bot, anchor: AnchorRect): void
  onMove(move: OrderMove): void
  /** Sets the whole selection: a swipe across the selection badges selects or deselects several pins at once. */
  onSelectionChange(selection: Selection): void
  gutter: number
  /** Dragging between this area and the rows list (`useCrossDrag`, owned by `HomeList`). */
  cross: CrossDrag
  /** The pins' `autoScrollMaxOverscroll`: 50 pt above, and down to the end of the scroll content below. */
  overscroll: [number, number]
}

export function PinnedArea(props: PinnedAreaProps) {
  const { pins, items, editing, layoutEditing, progress, selection, gateway, connectionId, haptics, scrollRef, unread, onPress, onLongPress, onMove, onSelectionChange, gutter, cross, overscroll } = props
  // Stable across renders that do not change the pins or the handlers, for
  // the same reason `HomeList` memoizes its own `Sortable.Grid` props. Kept
  // above the empty-pins return below: every hook here must run every render.
  // `Sortable.Flex` takes children, not data, so every key it hands back below is React's
  // own escaped child key, not the pin's own key (`sortableChildKey`'s own doc comment in
  // `drop-rules.ts`); each callback here reads it back at the boundary, before it reaches
  // `cross` or any drop rule.
  const onDragStart = useCallback(
    ({ key }: DragStartParams) => {
      lightTap(haptics)
      cross.begin(sortableChildKey(key))
    },
    [haptics, cross]
  )
  // The pinned area's own fixed geometry, for `pinCells`: stable unless `gutter` changes, so
  // `usePinSwipeSelect`'s effect that recomputes the cells does not fire on every render.
  const pinLayout = useMemo(() => pinAreaGeometry(gutter), [gutter])
  const swipe = usePinSwipeSelect(pins, selection, onSelectionChange, BADGE_OFFSET, pinLayout)

  const onDragMove = useCallback(
    (params: DragMoveParams) => {
      'worklet'
      cross.onDragMove({ ...params, key: sortableChildKey(params.key) })
    },
    [cross]
  )

  const onDragEnd = useCallback(
    ({ key, indexToKey }: SortableFlexDragEndParams) => {
      lightTap(haptics)
      const dragKey = sortableChildKey(key)
      const order = indexToKey.map(sortableChildKey)
      // Dropped over the rows list: unpinned there, so the order among the pins does not count.
      if (cross.end(dragKey)) {
        return
      }
      const move = pinDropMove(pins, order, dragKey)
      if (move) {
        onMove(move)
      }
    },
    [haptics, pins, onMove, cross]
  )

  const act = useCallback(
    (item: PinnedItem) => (event: AccessibilityActionEvent) => {
      const direction = moveDirection(event.nativeEvent.actionName)
      const move = direction ? moveStep(items, item.key, direction) : null
      if (move) {
        onMove(move)
      }
    },
    [items, onMove]
  )

  if (pins.length === 0) {
    return layoutEditing ? <PinnedSkeleton progress={progress} areaRef={cross.pinnedRef} slot={cross.slot} /> : null
  }

  return (
    <Sortable.Layer>
      {/* `Sortable.Flex` does not forward its own `onLayout`, and `pinCells` needs the pinned
          area's own width, so this outer view measures it instead; it stretches to the same width
          `Sortable.Flex` would have, so it changes nothing else about the layout. */}
      <Animated.View ref={cross.pinnedRef} collapsable={false} onLayout={swipe.onLayout}>
        <Sortable.Flex
          flexDirection="row"
          flexWrap="wrap"
          justifyContent="center"
          gap={PIN_GAP}
          paddingHorizontal={gutter}
          paddingVertical={PIN_PADDING_TOP}
          customHandle
          sortEnabled={editing}
          scrollableRef={scrollRef}
          dragActivationDelay={0}
          activeItemScale={1.05}
          inactiveItemOpacity={1}
          autoScrollMaxOverscroll={overscroll}
          onDragStart={onDragStart}
          onDragMove={onDragMove}
          onDragEnd={onDragEnd}
          onActiveItemDropped={cross.dropped}
        >
          {pins.map(item => (
            <PinnedAvatar
              key={item.key}
              item={item}
              editing={editing}
              progress={progress}
              selected={selection.has(item.bot.profile)}
              unread={unread(item.bot.profile)}
              actions={editing ? moveActions(items, item.key) : []}
              onAction={act(item)}
              gateway={gateway}
              connectionId={connectionId}
              onPress={() => onPress(item.bot)}
              onLongPress={anchor => onLongPress(item.bot, anchor)}
              swipe={swipe}
            />
          ))}
        </Sortable.Flex>
        <PinsMarker slot={cross.slot} height={AVATAR_SIZE} />
      </Animated.View>
    </Sortable.Layer>
  )
}

interface PinnedSkeletonProps {
  progress: SharedValue<number>
  /** The pinned area's measured view (`CrossDrag.pinnedRef`): the whole skeleton is a drop target for rows. */
  areaRef: CrossDrag['pinnedRef']
  slot: SharedValue<CrossSlot>
}

/**
 * The empty pinned area in Edit mode: three dashed ghost avatars and a
 * caption, fading with Edit mode's progress. While a dragged row is over
 * it, the middle ghost avatar, where a first pin lands, turns `primary`.
 */
function PinnedSkeleton({ progress, areaRef, slot }: PinnedSkeletonProps) {
  const theme = useTheme()
  const fade = useAnimatedStyle(() => ({ opacity: progress.get() }))
  const marker = useAnimatedStyle(() => ({ opacity: slot.get()?.area === 'pinned' ? 1 : 0 }))
  return (
    <Animated.View
      ref={areaRef}
      collapsable={false}
      accessible
      accessibilityLabel="Pinned agents, empty. Drag an agent here, or select one and choose Pin."
      style={[styles.skeleton, fade]}
    >
      <View style={styles.skeletonPins}>
        {SKELETON_PINS.map(i => (
          <View key={i} style={styles.ghostSlot}>
            <View style={[styles.ghostPin, { borderColor: theme.colors.mutedForeground }]} />
            {i === SKELETON_MIDDLE ? <Animated.View style={[styles.ghostMarker, { borderColor: theme.colors.primary }, marker]} /> : null}
          </View>
        ))}
      </View>
      <Text numberOfLines={1} maxFontSizeMultiplier={RULE.maxFontScale} style={[styles.label, { color: theme.colors.mutedForeground }]}>
        Drag an agent here to pin it
      </Text>
    </Animated.View>
  )
}

interface PinnedAvatarProps {
  item: PinnedItem
  editing: boolean
  progress: SharedValue<number>
  selected: boolean
  unread: boolean
  actions: ReturnType<typeof moveActions>
  onAction(event: AccessibilityActionEvent): void
  gateway: PinnedAreaProps['gateway']
  connectionId: string
  onPress(): void
  onLongPress(anchor: AnchorRect): void
  swipe: PinSwipeSelect
}

function PinnedAvatar({ item, editing, progress, selected, unread, actions, onAction, gateway, connectionId, onPress, onLongPress, swipe }: PinnedAvatarProps) {
  const theme = useTheme()
  const { bot } = item
  const avatar = useAvatar(gateway, connectionId, bot.profile, bot.hasAvatar)
  const ref = useRef<View>(null)
  const badge = useAnimatedStyle(() => ({ opacity: progress.get(), transform: [{ scale: progress.get() }] }))
  // The badge and the move handle sit at the avatar's top-left and top-right,
  // so the unread dot moves down to clear them both, the same way for every avatar.
  const dotPosition = useAnimatedStyle(() => ({ transform: [{ translateY: progress.get() * DOT_DROP }] }))
  const measure = () => ref.current?.measureInWindow((x, y, width, height) => onLongPress({ x, y, width, height }))
  // Gated by the badge's own `pointerEvents` below, not by rebuilding the
  // gesture: outside Edit mode no touch ever reaches it (HomeRow does the same).
  const swipeGesture = useMemo(() => swipe.gestureFor(item.key), [swipe, item.key])
  useEffect(() => () => swipe.forget(item.key), [swipe, item.key])
  const face = (
    <Pressable
      onPress={onPress}
      onLongPress={editing ? undefined : measure}
      accessibilityRole="button"
      accessibilityLabel={editing ? editRowLabel(bot, selected, unread) : `${bot.name}${unread ? ', unread' : ''}`}
      accessibilityActions={actions}
      onAccessibilityAction={onAction}
      style={styles.pin}
    >
      <Avatar name={bot.name} color={bot.color} imageUri={avatar.data ?? null} size={AVATAR_SIZE} />
      <Text style={[styles.label, { color: theme.colors.mutedForeground }]} numberOfLines={1}>
        {bot.name}
      </Text>
      {unread ? <Animated.View style={[styles.dot, { backgroundColor: theme.colors.primary }, dotPosition]} accessibilityLabel="Unread" /> : null}
    </Pressable>
  )
  return (
    <View ref={ref} collapsable={false}>
      {face}
      {/* A touch that starts here belongs to swipe to select; a tap still toggles, the same way a tap on the avatar does. */}
      <GestureDetector gesture={swipeGesture}>
        <Animated.View pointerEvents={editing ? 'auto' : 'none'} style={[styles.badge, badge]}>
          <SelectionCircle selected={selected} size={BADGE_SIZE} onAvatar />
        </Animated.View>
      </GestureDetector>
      <Animated.View pointerEvents={editing ? 'auto' : 'none'} style={[styles.move, badge]}>
        <Sortable.Handle style={styles.moveTouch}>
          <View style={[styles.moveBadge, { backgroundColor: theme.colors.background, borderColor: theme.colors.mutedForeground }]}>
            <Grip size={MOVE_GRIP_SIZE} />
          </View>
        </Sortable.Handle>
      </Animated.View>
    </View>
  )
}

const styles = StyleSheet.create({
  pin: { alignItems: 'center', gap: SPACE.small, width: PIN_WIDTH },
  label: { ...TYPE.callout },
  dot: { position: 'absolute', top: SPACE.hairline, right: SPACE.small, width: SIZE.tiny, height: SIZE.tiny, borderRadius: SIZE.tiny / 2 },
  // The badge and the move handle center on the avatar's round edge at 45°, top left and top right (see the arithmetic above).
  badge: { position: 'absolute', top: BADGE_OFFSET.y, left: BADGE_OFFSET.x },
  // The move handle's touch area is the minimum touch target around its badge.
  move: { position: 'absolute', top: BADGE_CENTER_Y - RULE.touch / 2, left: MOVE_CENTER_X - RULE.touch / 2 },
  moveTouch: { width: RULE.touch, height: RULE.touch, alignItems: 'center', justifyContent: 'center' },
  moveBadge: { width: BADGE_SIZE, height: BADGE_SIZE, borderRadius: BADGE_SIZE / 2, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center' },
  // The caption sits where a pin's name would, `SPACE.small` under the ghost avatars (`styles.pin`'s gap). At the
  // largest text size its one line (15 pt × RULE.maxFontScale) still fits the 38 pt under them; the box clips anything past its height.
  skeleton: { height: PINNED_SKELETON_HEIGHT, paddingTop: PIN_PADDING_TOP, alignItems: 'center', gap: SPACE.small, overflow: 'hidden' },
  skeletonPins: { flexDirection: 'row', gap: SKELETON_PIN_GAP },
  ghostSlot: { width: AVATAR_SIZE, height: AVATAR_SIZE },
  ghostPin: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, borderRadius: AVATAR_SIZE / 2, borderWidth: 1.5, borderStyle: 'dashed', opacity: OPACITY.medium },
  ghostMarker: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, borderRadius: AVATAR_SIZE / 2, borderWidth: 2 }
})
