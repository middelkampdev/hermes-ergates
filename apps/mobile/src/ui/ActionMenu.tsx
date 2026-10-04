/**
 * Compact anchored action menu (docs/10 "Bot actions"): a transparent modal
 * with an outside-tap backdrop and an opaque `popover` card positioned next
 * to a measured anchor rect, kept within the window. Android back dismisses
 * via `onRequestClose`.
 *
 * One menu with hairline separators between groups, a back-chevron header row
 * for the Move and Create levels, and a trailing chevron on rows that open a
 * level (Move to). The Create level additionally draws a name field and a
 * primary button, and keeps both clear of the keyboard.
 */

import { useEffect, useState } from 'react'
import { Keyboard, Modal, Platform, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native'

import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { useTheme } from '@/theme/provider'
import { ICON, SCRIM, TYPE } from '@/theme/tokens'

import { Button } from './Button'
import { Field } from './Field'
import { Icon, type IconName } from './icons'
import { menuPosition } from './menu-position'
import { SurfaceProvider } from './surface-context'

const MENU_WIDTH = 240
const MENU_RADIUS = 16
const MARGIN = 8
const SEPARATOR_HEIGHT = 9
/** Rough height of the Create level's field + button, added to the header row's height. */
const CREATE_FORM_HEIGHT = 140

export interface AnchorRect {
  x: number
  y: number
  width: number
  height: number
}

export interface ActionMenuItem {
  kind: 'item'
  key: string
  label: string
  icon?: IconName
  chevron?: boolean
  destructive?: boolean
  /** Announced as selected by the screen reader; never drawn into the label. */
  selected?: boolean
  onPress: () => void
}

export interface ActionMenuSeparator {
  kind: 'separator'
  key: string
}

export type ActionMenuRow = ActionMenuItem | ActionMenuSeparator

export interface ActionMenuCreateSection {
  value: string
  onChangeText(text: string): void
  disabled: boolean
  onCreate(): void
}

export interface ActionMenuProps {
  visible: boolean
  anchor: AnchorRect | null
  items: ActionMenuRow[]
  /** Present only on the Create level: draws the name field and the Create button below `items`. */
  createSection?: ActionMenuCreateSection
  onClose: () => void
}

/** Tracks the on-screen keyboard height, only while `active` (the Create level's field can take focus). */
function useKeyboardHeight(active: boolean): number {
  const [height, setHeight] = useState(0)
  useEffect(() => {
    if (!active) {
      setHeight(0)
      return
    }
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow'
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide'
    const showSub = Keyboard.addListener(showEvent, e => setHeight(e.endCoordinates.height))
    const hideSub = Keyboard.addListener(hideEvent, () => setHeight(0))
    return () => {
      showSub.remove()
      hideSub.remove()
    }
  }, [active])
  return height
}

export function ActionMenu({ visible, anchor, items, createSection, onClose }: ActionMenuProps) {
  const theme = useTheme()
  const { width, height } = useWindowDimensions()
  const keyboardHeight = useKeyboardHeight(Boolean(createSection))

  const rowsHeight = items.reduce((total, row) => total + (row.kind === 'separator' ? SEPARATOR_HEIGHT : theme.hit), 0)
  const menuHeight = rowsHeight + (createSection ? CREATE_FORM_HEIGHT : 0) + MARGIN * 2
  const insets = useSafeAreaInsets()
  const position = anchor
    ? menuPosition({ anchor, screen: { width, height }, insets, keyboardHeight, menu: { width: MENU_WIDTH, height: menuHeight }, margin: MARGIN })
    : null

  return (
    <Modal transparent visible={visible && !!position} animationType="fade" onRequestClose={onClose}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Close menu"
        style={[StyleSheet.absoluteFill, styles.backdrop]}
        onPress={onClose}
      />
      {position ? (
        <View
          style={[styles.card, { top: position.top, left: position.left, width: MENU_WIDTH }]}
        >
          {/* The card is the Field's surface on the Create level, so its fill stays visible in dark themes. */}
          <SurfaceProvider color={theme.colors.popover}>
            <View style={[styles.surface, { backgroundColor: theme.colors.popover, borderColor: theme.colors.border }]}>
              {items.map(row =>
                row.kind === 'separator' ? (
                  <View key={row.key} style={[styles.separator, { backgroundColor: theme.colors.border }]} />
                ) : (
                  <Pressable
                    key={row.key}
                    // The row decides whether the menu closes: submenu rows only
                    // change level, and terminal rows close themselves.
                    onPress={row.onPress}
                    accessibilityRole="button"
                    accessibilityLabel={row.label}
                    accessibilityState={{ selected: row.selected }}
                    style={({ pressed }) => [
                      styles.row,
                      { minHeight: theme.hit, backgroundColor: pressed ? theme.colors.muted : 'transparent' }
                    ]}
                  >
                    {row.icon ? (
                      <Icon name={row.icon} size={ICON.small} color={row.destructive ? theme.colors.destructive : theme.colors.foreground} />
                    ) : null}
                    <Text
                      numberOfLines={1}
                      style={[styles.label, { color: row.destructive ? theme.colors.destructive : theme.colors.foreground }]}
                    >
                      {row.label}
                    </Text>
                    {row.chevron ? <Icon name="chevron-right" size={ICON.small} color={theme.colors.mutedForeground} /> : null}
                  </Pressable>
                )
              )}
              {createSection ? (
                <View style={styles.createForm}>
                  <Field
                    label=""
                    value={createSection.value}
                    onChangeText={createSection.onChangeText}
                    placeholder="Section name"
                    accessibilityLabel="Section name"
                    autoFocus
                  />
                  <Button label="Create" onPress={createSection.onCreate} disabled={createSection.disabled} />
                </View>
              ) : null}
            </View>
          </SurfaceProvider>
        </View>
      ) : null}
    </Modal>
  )
}

const styles = StyleSheet.create({
  backdrop: {
    backgroundColor: SCRIM
  },
  // No shadow: in dark themes a shadow drawn in a light color glows. A hairline
  // border in the separator color marks the card's edge on every theme instead.
  card: {
    position: 'absolute'
  },
  surface: {
    borderRadius: MENU_RADIUS,
    borderWidth: StyleSheet.hairlineWidth,
    paddingVertical: MARGIN,
    overflow: 'hidden'
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 14
  },
  label: {
    ...TYPE.callout,
    flexShrink: 1,
    flexGrow: 1
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    marginHorizontal: 14,
    marginVertical: 4
  },
  createForm: {
    paddingHorizontal: 14,
    paddingTop: 4
  }
})
