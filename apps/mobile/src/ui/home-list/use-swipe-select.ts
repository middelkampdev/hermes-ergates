/**
 * Swipe to select in Home Edit mode (the rules are in the agents feature's
 * `swipe-select.ts`). Each row's circle column carries a pan with no minimum
 * distance: it takes the touch at its first move, so the scroll view never
 * gets it, and it applies the range at once, the start row included, so a
 * slight move on a tap still toggles the row exactly once. A touch that does
 * not move stays the row's own tap. On the UI thread the pan follows the line
 * under the finger and tells the JS thread only when that line changes; a
 * frame callback scrolls the list while the finger is near its top or bottom
 * edge, and the range grows with the rows that scroll under the finger.
 *
 * The rows list starts below the pinned avatars, so every y here is measured
 * from the top of the rows list, and `onListLayout` tells the gesture where
 * that top sits in the scroll content.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { LayoutChangeEvent } from 'react-native'
import { Gesture, type PanGesture } from 'react-native-gesture-handler'
import Animated, { scrollTo, useFrameCallback, useScrollOffset, useSharedValue, type AnimatedRef, type FrameInfo } from 'react-native-reanimated'
import { scheduleOnRN } from 'react-native-worklets'

import {
  autoScrollOffset,
  autoScrollSpeed,
  lineAt,
  lineTop,
  pinAt,
  pinCells,
  swipeLines,
  swipeMode,
  swipeSelection,
  type DragItem,
  type PinAreaLayout,
  type PinCell,
  type PinnedItem,
  type Selection,
  type SwipeLine,
  type SwipeMode
} from '@/features/agents'

/** What a row's selection circle needs from swipe to select. */
export interface SwipeSelect {
  /** Builds the swipe gesture for the row with this key. */
  gestureFor(key: string): PanGesture
  /** The row with this key left the list; a swipe that started on it ends. */
  forget(key: string): void
}

/** The swipe in progress, on the JS thread: where it started, the selection before it, and whether it selects or deselects. */
interface SwipeStart {
  startKey: string
  base: Selection
  mode: SwipeMode
}

/** `items` is the rows list as it shows: rows, section headers and the ghost rows of empty sections. */
export function useSwipeSelect(scrollRef: AnimatedRef<Animated.ScrollView>, items: DragItem[], selection: Selection, onSelectionChange: (selection: Selection) => void) {
  const lines = useSharedValue<SwipeLine[]>([])
  useEffect(() => {
    lines.set(swipeLines(items))
  }, [items, lines])
  const scrollOffset = useScrollOffset(scrollRef)
  const viewportHeight = useSharedValue(0)
  const contentHeight = useSharedValue(0)
  /** Where the rows list starts in the scroll content: below the error line and the pinned avatars. */
  const listTop = useSharedValue(0)
  const active = useSharedValue(false)
  // The line under the finger, the finger's distance from the list's visible
  // top edge, and the scroll offset the swipe keeps itself while it scrolls
  // (the scroll events report a new offset only a frame later).
  const currentKey = useSharedValue<string | null>(null)
  const fingerY = useSharedValue(0)
  const offset = useSharedValue(0)

  // The gestures are built once per row, so the JS side reads the latest props from here.
  const latest = useRef({ items, selection, onSelectionChange })
  latest.current = { items, selection, onSelectionChange }
  const swipe = useRef<SwipeStart | null>(null)

  const showLine = useCallback((key: string) => {
    const start = swipe.current
    if (start) {
      latest.current.onSelectionChange(swipeSelection(latest.current.items, start.base, start.startKey, key, start.mode))
    }
  }, [])

  const track = useCallback(
    (listY: number) => {
      'worklet'
      const key = lineAt(lines.get(), listY)
      if (key !== null && key !== currentKey.get()) {
        currentKey.set(key)
        scheduleOnRN(showLine, key)
      }
    },
    [lines, currentKey, showLine]
  )

  const autoScroll = useFrameCallback(
    useCallback(
      (frame: FrameInfo) => {
        'worklet'
        if (!active.get()) {
          return
        }
        const speed = autoScrollSpeed(fingerY.get(), viewportHeight.get())
        if (speed === 0) {
          return
        }
        const next = autoScrollOffset(offset.get(), speed, frame.timeSincePreviousFrame ?? 0, contentHeight.get() - viewportHeight.get())
        if (next === offset.get()) {
          return
        }
        offset.set(next)
        scrollTo(scrollRef, 0, next, false)
        track(fingerY.get() + next - listTop.get())
      },
      [active, fingerY, viewportHeight, offset, contentHeight, scrollRef, track, listTop]
    ),
    false
  )

  const begin = useCallback(
    (key: string) => {
      const { items: now, selection: base, onSelectionChange: change } = latest.current
      const mode = swipeMode(now, base, key)
      swipe.current = { startKey: key, base, mode }
      autoScroll.setActive(true)
      change(swipeSelection(now, base, key, key, mode))
    },
    [autoScroll]
  )

  const finish = useCallback(() => {
    swipe.current = null
    autoScroll.setActive(false)
  }, [autoScroll])

  // A row that leaves the list mid-swipe (a roster refresh) takes its gesture
  // with it, and that gesture never reports its end: end the swipe here, or
  // the auto-scroll would keep running on a finger that is gone.
  const forget = useCallback(
    (key: string) => {
      if (swipe.current?.startKey === key) {
        active.set(false)
        currentKey.set(null)
        finish()
      }
    },
    [active, currentKey, finish]
  )

  const gestureFor = useCallback(
    (key: string) =>
      Gesture.Pan()
        .minDistance(0)
        .maxPointers(1)
        .onStart(event => {
          'worklet'
          const top = lineTop(lines.get(), key)
          if (top < 0) {
            return
          }
          // `event.y` is measured from the top of this row's circle column, which scrolls with the content.
          const now = scrollOffset.get()
          offset.set(now)
          fingerY.set(listTop.get() + top + event.y - now)
          currentKey.set(key)
          active.set(true)
          scheduleOnRN(begin, key)
        })
        .onUpdate(event => {
          'worklet'
          if (!active.get()) {
            return
          }
          const listY = lineTop(lines.get(), key) + event.y
          fingerY.set(listTop.get() + listY - offset.get())
          track(listY)
        })
        .onFinalize(() => {
          'worklet'
          if (!active.get()) {
            return
          }
          active.set(false)
          currentKey.set(null)
          scheduleOnRN(finish)
        }),
    [lines, scrollOffset, offset, fingerY, listTop, currentKey, active, begin, track, finish]
  )

  const select = useMemo<SwipeSelect>(() => ({ gestureFor, forget }), [gestureFor, forget])

  return {
    select,
    /** The rows list's lines as it shows; the drag between the pinned area and the rows list finds its slot in them too. */
    lines,
    /** The scroll view's own layout: its height is the viewport the auto-scroll edges are measured in. */
    onLayout: (event: LayoutChangeEvent) => {
      viewportHeight.set(event.nativeEvent.layout.height)
    },
    onContentSizeChange: (_width: number, height: number) => {
      contentHeight.set(height)
    },
    /** The rows list's layout inside the scroll content. */
    onListLayout: (event: LayoutChangeEvent) => {
      listTop.set(event.nativeEvent.layout.y)
    }
  }
}

/** The cell for a pin's key, or null while it is not yet measured (or no longer shown). */
function cellFor(cells: readonly PinCell[], key: string): PinCell | null {
  'worklet'
  for (const cell of cells) {
    if (cell.key === key) {
      return cell
    }
  }
  return null
}

/** What a pinned avatar's selection badge needs from swipe to select. */
export interface PinSwipeSelect {
  /** Builds the swipe gesture for the pin's badge with this key. */
  gestureFor(key: string): PanGesture
  /** The pinned area's own container: its width is all the pins' computed cells need beyond their fixed geometry (`onLayout` on `PinnedArea`'s outer `View`). */
  onLayout(event: LayoutChangeEvent): void
  /** The pin with this key left the pinned area; a swipe that started on it ends. */
  forget(key: string): void
}

/** The swipe in progress over the pins, on the JS thread. */
interface PinSwipeStart {
  startKey: string
  base: Selection
  mode: SwipeMode
}

/**
 * Swipe to select over the pinned avatars: the same iOS Mail rule as
 * `useSwipeSelect` above, starting on a pin's selection badge instead of a
 * row's circle, and hit-tested against the pins' own cells (`pinAt`) instead
 * of the rows list's fixed line heights. The cells are not measured per pin
 * — a pin sits inside a react-native-sortables item wrapper, so its own
 * `onLayout` would report a position relative to that wrapper, not to the
 * pinned area, and several pins measuring in the same frame would race the
 * shared value that held their cells. `pinCells` computes them instead, from
 * the pins' own key order and `geometry`, the pinned area's fixed layout
 * (`PinnedArea` owns it); `onLayout` below measures only the one thing
 * `pinCells` cannot know ahead of time, the pinned area's own width. No
 * auto-scroll: the pinned area sits at the top of the list, so it never
 * needs the list to scroll itself. `badgeOffset` is the selection badge's
 * fixed position inside its pin's cell (top left; `PinnedArea` owns the
 * geometry it comes from), used to turn a touch on the small badge into a
 * point in the pinned area: `event.x`/`event.y` are measured from the
 * badge's own top left, the same way a row's `event.y` is measured from its
 * circle column's top.
 */
export function usePinSwipeSelect(
  pins: PinnedItem[],
  selection: Selection,
  onSelectionChange: (selection: Selection) => void,
  badgeOffset: { x: number; y: number },
  geometry: Omit<PinAreaLayout, 'width'>
): PinSwipeSelect {
  const cells = useSharedValue<PinCell[]>([])
  const [width, setWidth] = useState(0)
  const active = useSharedValue(false)
  const currentKey = useSharedValue<string | null>(null)

  // The gesture is built once per pin, so the JS side reads the latest props from here.
  const latest = useRef({ pins, selection, onSelectionChange })
  latest.current = { pins, selection, onSelectionChange }
  const swipe = useRef<PinSwipeStart | null>(null)

  // A stable `keys` array, so the effect below only recomputes the cells
  // when the pin order actually changes (a pin drag reorders the pins), or
  // the pinned area's own width or geometry does, not on every render that
  // leaves the order the same. '\u0000' cannot appear in a pin key.
  const keysSignature = pins.map(pin => pin.key).join('\u0000')
  const keys = useMemo(() => (keysSignature === '' ? [] : keysSignature.split('\u0000')), [keysSignature])
  useEffect(() => {
    cells.set(pinCells(keys, { ...geometry, width }))
  }, [cells, keys, width, geometry])

  const showPin = useCallback((key: string) => {
    const start = swipe.current
    if (start) {
      latest.current.onSelectionChange(swipeSelection(latest.current.pins, start.base, start.startKey, key, start.mode))
    }
  }, [])

  const track = useCallback(
    (x: number, y: number) => {
      'worklet'
      const key = pinAt(cells.get(), x, y)
      if (key !== null && key !== currentKey.get()) {
        currentKey.set(key)
        scheduleOnRN(showPin, key)
      }
    },
    [cells, currentKey, showPin]
  )

  const begin = useCallback((key: string) => {
    const { pins: now, selection: base, onSelectionChange: change } = latest.current
    const mode = swipeMode(now, base, key)
    swipe.current = { startKey: key, base, mode }
    change(swipeSelection(now, base, key, key, mode))
  }, [])

  const finish = useCallback(() => {
    swipe.current = null
  }, [])

  // A pin that leaves the pinned area mid-swipe (unpinned by the bottom bar
  // while its own badge is mid-gesture) takes its gesture with it, and that
  // gesture never reports its end: end the swipe here, the same reason rows do.
  const forget = useCallback(
    (key: string) => {
      if (swipe.current?.startKey === key) {
        active.set(false)
        currentKey.set(null)
        finish()
      }
    },
    [active, currentKey, finish]
  )

  const gestureFor = useCallback(
    (key: string) =>
      Gesture.Pan()
        .minDistance(0)
        .maxPointers(1)
        .onStart(() => {
          'worklet'
          if (!cellFor(cells.get(), key)) {
            return
          }
          currentKey.set(key)
          active.set(true)
          scheduleOnRN(begin, key)
        })
        .onUpdate(event => {
          'worklet'
          if (!active.get()) {
            return
          }
          const cell = cellFor(cells.get(), key)
          if (!cell) {
            return
          }
          // `cell.x`/`cell.y` are the pin's own cell, top left, in the pinned
          // area's own coordinates (what `pinCells` computes); `badgeOffset`
          // is the badge's fixed top left inside that cell; `event.x`/`.y`
          // are measured from the badge's own top left. A touch near the
          // badge's center (event.x ≈ event.y ≈ BADGE_SIZE / 2, 14 pt) lands
          // at roughly cell.x + 16.9 and cell.y + 12.9 (BADGE_OFFSET in
          // PinnedArea.tsx is {x: 2.9, y: -1.1} there) — inside the cell's
          // own [0, PIN_WIDTH) × [0, PIN_CELL_HEIGHT), so `pinAt` below finds
          // this same pin.
          track(cell.x + badgeOffset.x + event.x, cell.y + badgeOffset.y + event.y)
        })
        .onFinalize(() => {
          'worklet'
          if (!active.get()) {
            return
          }
          active.set(false)
          currentKey.set(null)
          scheduleOnRN(finish)
        }),
    [cells, currentKey, active, begin, track, finish, badgeOffset]
  )

  const onLayout = useCallback((event: LayoutChangeEvent) => {
    setWidth(event.nativeEvent.layout.width)
  }, [])

  return useMemo<PinSwipeSelect>(() => ({ gestureFor, onLayout, forget }), [gestureFor, onLayout, forget])
}
