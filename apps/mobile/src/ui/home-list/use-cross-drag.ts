/**
 * Dragging an agent between the pinned area and the rows list in Home Edit
 * mode (docs/10 "Home edit mode"; the rules are the agents feature's
 * `crossSlot`, `crossMove` and `crossDrop`): a row dragged by its ≡ and
 * dropped over the pinned area is pinned at that spot, and a pin dragged by
 * its move handle and dropped over the rows list is unpinned and placed
 * there. The move goes to Home's `onMove`, the organizer, which queues the
 * pinned flag (and the section, when it changed) for Hermes.
 *
 * react-native-sortables 1.10 cannot hand an item from one drag list to
 * another, so each area keeps its own drag and this hook follows the finger:
 * both lists' `onDragStart` name the drag to follow (`begin`), their
 * `onDragMove` record its finger on the UI thread, and one reaction over the
 * finger and the scroll offset measures both areas and the part of the
 * scroll view the owner sees, and keeps `slot`, the slot under the finger in
 * the other area, current. It listens to the scroll offset too because
 * `onDragMove` is silent while the list auto-scrolls under a still finger.
 * `slot` drives the insertion markers (`CrossMarkers.tsx`) and, while a row
 * is over the pinned area, the rows list's sort strategy. At the drop, each
 * area's `onDragEnd` asks `end` first: over the other area, the move goes to
 * Home and the area skips its own drop.
 *
 * A full-width row over the pinned area would hide the avatars and the
 * marker, so while it is there the row fades: the rows list's
 * `activeItemOpacity` (`rowOpacity`) takes the lifted row to
 * `HOVER_OPACITY`, its `activeItemShadowOpacity` (`rowShadow`) drops the
 * library's shadow, and the row's own background layer clears
 * (`hovering`, read by `HomeRow`). Only the lifted row changes.
 */

import { useCallback, useEffect, useMemo, useRef } from 'react'
import Animated, { measure, useAnimatedReaction, useAnimatedRef, useScrollOffset, useSharedValue, withTiming, type AnimatedRef, type SharedValue } from 'react-native-reanimated'
import type { DragMoveParams } from 'react-native-sortables'

import { crossDrop, crossSlot, pageRect, pinCells, sameSlot, visibleArea, type CrossSlot, type DragItem, type PinAreaLayout, type PinnedItem, type Point, type SwipeLine } from '@/features/agents'
import type { OrderMove } from '@/state/organization'
import { OPACITY } from '@/theme/tokens'

/**
 * When a drop over the other area is applied. False: at the release, while
 * the library still flies the dragged item back to its old slot (300 ms);
 * the data change takes it out on the way, so it cross-fades into the new
 * avatar or row at the drop spot: the hand-off the owner accepted on the
 * simulator. True: after that drop animation (`onActiveItemDropped`); the
 * item then lands back in its old slot first and moves over afterwards.
 */
const APPLY_AFTER_DROP_ANIMATION = false

/** How strong a lifted row stays while it is over the pinned area: the avatars and the marker show through it. */
const HOVER_OPACITY: number = OPACITY.faint
const HOVER_FADE_MS = 120
/** The shadow strength under a lifted item: the library's `activeItemShadowOpacity`, which its default sets to 0.2, snapped to the nearest opacity step. */
const LIFTED_SHADOW_OPACITY: number = OPACITY.faint

export interface CrossDrag {
  /** On the pinned area's outer view, pins or skeleton. */
  pinnedRef: AnimatedRef<Animated.View>
  /** On the rows list's outer view. */
  rowsRef: AnimatedRef<Animated.View>
  /** The slot under the finger in the other area while a drag hovers there, else null. */
  slot: SharedValue<CrossSlot>
  /** The key of the lifted row while it is over the pinned area, else null: that row clears its background. */
  hovering: SharedValue<string | null>
  /** The rows list's `activeItemOpacity`: 1, or `HOVER_OPACITY` while the lifted row is over the pinned area. */
  rowOpacity: SharedValue<number>
  /** The rows list's `activeItemShadowOpacity`: `LIFTED_SHADOW_OPACITY`, or none while the lifted row is over the pinned area. */
  rowShadow: SharedValue<number>
  /** Both drag lists' `onDragStart`: the drag to follow from now on; a state left by a drag that never ended is dropped. */
  begin(key: string): void
  /** Both drag lists' `onDragMove`, on the UI thread: records the finger of the followed drag. */
  onDragMove(params: DragMoveParams): void
  /**
   * The first step of both drag lists' `onDragEnd`: true when the drag ended
   * over the other area. Its move is then applied (or held for the drop
   * animation) and the caller skips its own drop.
   */
  end(key: string): boolean
  /** Both drag lists' `onActiveItemDropped`: applies a move held for the drop animation. */
  dropped(): void
}

interface CrossDragOptions {
  scrollRef: AnimatedRef<Animated.ScrollView>
  pins: readonly PinnedItem[]
  /** The rows list as it shows, ghost rows included: what `lines` holds the heights of. */
  shown: readonly DragItem[]
  /** The rows list's lines, kept by swipe to select (`useSwipeSelect`). */
  lines: SharedValue<SwipeLine[]>
  /** The pinned area's fixed geometry (`pinAreaGeometry`); its width comes from measuring it. */
  pinGeometry: Omit<PinAreaLayout, 'width'>
  /** How much of the scroll view's bottom an overlay covers (the Edit bar while it shows): no drop lands there. */
  bottomCover: number
  onMove(move: OrderMove): void
}

export function useCrossDrag({ scrollRef, pins, shown, lines, pinGeometry, bottomCover, onMove }: CrossDragOptions): CrossDrag {
  const pinnedRef = useAnimatedRef<Animated.View>()
  const rowsRef = useAnimatedRef<Animated.View>()
  const scrollOffset = useScrollOffset(scrollRef)
  /** The key of the drag whose finger is followed; one drag at a time. */
  const dragKey = useSharedValue<string | null>(null)
  const finger = useSharedValue<Point | null>(null)
  const slot = useSharedValue<CrossSlot>(null)
  const hovering = useSharedValue<string | null>(null)
  const rowOpacity = useSharedValue(1)
  const rowShadow = useSharedValue(LIFTED_SHADOW_OPACITY)
  const pinKeys = useSharedValue<string[]>([])
  useEffect(() => {
    pinKeys.set(pins.map(pin => pin.key))
  }, [pins, pinKeys])
  const cover = useSharedValue(bottomCover)
  useEffect(() => {
    cover.set(bottomCover)
  }, [bottomCover, cover])

  // The drop reads the latest props from here; a move held for the drop animation waits here.
  const latest = useRef({ pins, shown, onMove })
  latest.current = { pins, shown, onMove }
  const held = useRef<OrderMove | null>(null)

  const begin = useCallback(
    (key: string) => {
      dragKey.set(key)
      finger.set(null)
      slot.set(null)
      hovering.set(null)
      rowOpacity.set(1)
      rowShadow.set(LIFTED_SHADOW_OPACITY)
    },
    [dragKey, finger, slot, hovering, rowOpacity, rowShadow]
  )

  const onDragMove = useCallback(
    ({ key, touchData }: DragMoveParams) => {
      'worklet'
      if (dragKey.get() === key) {
        finger.set({ x: touchData.absoluteX, y: touchData.absoluteY })
      }
    },
    [dragKey, finger]
  )

  useAnimatedReaction(
    () => ({ key: dragKey.get(), point: finger.get(), offset: scrollOffset.get(), bottom: cover.get() }),
    ({ key, point, bottom }) => {
      let next: CrossSlot = null
      if (key !== null && point !== null) {
        const pinnedArea = pageRect(measure(pinnedRef))
        next = crossSlot({
          key,
          finger: point,
          pinnedArea,
          rowsList: pageRect(measure(rowsRef)),
          cells: pinnedArea ? pinCells(pinKeys.get(), { ...pinGeometry, width: pinnedArea.width }) : [],
          pinGap: pinGeometry.gap,
          lines: lines.get(),
          visible: visibleArea(pageRect(measure(scrollRef)), bottom)
        })
      }
      if (!sameSlot(next, slot.get())) {
        slot.set(next)
      }
      // Only a row has a pin slot: while it has one, it fades over the pins.
      const over = next !== null && next.area === 'pinned' ? key : null
      if (over !== hovering.get()) {
        hovering.set(over)
        rowOpacity.set(withTiming(over === null ? 1 : HOVER_OPACITY, { duration: HOVER_FADE_MS }))
        rowShadow.set(over === null ? LIFTED_SHADOW_OPACITY : 0)
      }
    },
    [pinGeometry]
  )

  const end = useCallback(
    (key: string) => {
      const drop = crossDrop(dragKey.get(), key, slot.get(), latest.current.pins, latest.current.shown)
      if (drop === null) {
        return false
      }
      dragKey.set(null)
      finger.set(null)
      slot.set(null)
      if (drop.move && APPLY_AFTER_DROP_ANIMATION) {
        held.current = drop.move
      } else if (drop.move) {
        latest.current.onMove(drop.move)
      }
      return drop.over
    },
    [dragKey, finger, slot]
  )

  const dropped = useCallback(() => {
    const move = held.current
    held.current = null
    if (move) {
      latest.current.onMove(move)
    }
  }, [])

  // Stable, so the drag lists' callbacks that name it stay stable too.
  return useMemo(
    () => ({ pinnedRef, rowsRef, slot, hovering, rowOpacity, rowShadow, begin, onDragMove, end, dropped }),
    [pinnedRef, rowsRef, slot, hovering, rowOpacity, rowShadow, begin, onDragMove, end, dropped]
  )
}
