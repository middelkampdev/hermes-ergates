/**
 * A pushed page (docs/10 section 4): a back chevron on the left, the title
 * centered, an optional action on the right, and a scrolling body. On iOS
 * the body is inset by the keyboard (`automaticallyAdjustKeyboardInsets`)
 * rather than shrunk by a keyboard-avoiding view: a tall text field then
 * scrolls into view and the caret stays above the keyboard. A `footer` stays
 * where it is, so no page with a footer holds a text field. Android does not
 * avoid the keyboard here: with edge-to-edge the window is not resized for
 * it, and the old avoiding view had no Android behavior either.
 *
 * Both sides of the header take the width of the wider one, measured from
 * their content, so the title stays centered and the right action is never
 * squeezed, also at large text sizes; the title truncates instead.
 *
 * `variant: 'modal'` is for a page that is the root of a modal sheet
 * (Settings): the same header and body, but a close ✕ instead of the back
 * chevron, matching the other sheets' close control.
 */

import { useState, type ReactElement, type ReactNode } from 'react'
import { ScrollView, type LayoutChangeEvent, type RefreshControlProps, StyleSheet, Text, View } from 'react-native'

import { useTheme } from '@/theme/provider'
import { LEGACY_SIZE, TYPE } from '@/theme/tokens'

import { IconButton } from './IconButton'
import { Screen } from './Screen'
import { useBottomInset } from './use-bottom-inset'

export interface PageProps {
  title: string
  onBack: () => void
  variant?: 'push' | 'modal'
  right?: ReactNode
  /** Pull-to-refresh for the scrolling body. */
  refreshControl?: ReactElement<RefreshControlProps>
  /** A fixed area below the body (a primary action); it pads itself by the bottom inset. */
  footer?: ReactNode
  children: ReactNode
}

const BODY_BOTTOM_PADDING = 24
const FOOTER_BOTTOM_PADDING = 16

export function Page({ title, onBack, variant = 'push', right, refreshControl, footer, children }: PageProps) {
  const theme = useTheme()
  const bodyInset = useBottomInset(BODY_BOTTOM_PADDING)
  const footerInset = useBottomInset(FOOTER_BOTTOM_PADDING)
  // A footer carries the inset itself, so the body must not add it again.
  const bottomInset = footer ? BODY_BOTTOM_PADDING : bodyInset
  const [leftWidth, setLeftWidth] = useState(0)
  const [rightWidth, setRightWidth] = useState(0)
  const sideWidth = Math.max(LEGACY_SIZE.hit, leftWidth, rightWidth)
  const measure = (set: (width: number) => void) => (event: LayoutChangeEvent) => set(event.nativeEvent.layout.width)
  return (
    <Screen edges={['top']}>
      <View style={styles.header}>
        <View style={[styles.side, styles.left, { minWidth: sideWidth }]}>
          <View onLayout={measure(setLeftWidth)}>
            <IconButton name={variant === 'modal' ? 'x' : 'chevron-left'} accessibilityLabel={variant === 'modal' ? 'Close' : 'Back'} onPress={onBack} />
          </View>
        </View>
        <Text numberOfLines={1} accessibilityRole="header" style={[styles.title, { color: theme.colors.foreground }]}>
          {title}
        </Text>
        <View style={[styles.side, styles.right, { minWidth: sideWidth }]}>
          {right ? <View onLayout={measure(setRightWidth)}>{right}</View> : null}
        </View>
      </View>
      <View style={styles.fill}>
        <ScrollView
          style={styles.fill}
          keyboardShouldPersistTaps="handled"
          automaticallyAdjustKeyboardInsets
          refreshControl={refreshControl}
          contentContainerStyle={[styles.body, { paddingBottom: bottomInset }]}
        >
          {children}
        </ScrollView>
        {footer ? <View style={[styles.footer, { backgroundColor: theme.colors.background, paddingBottom: footerInset }]}>{footer}</View> : null}
      </View>
    </Screen>
  )
}

const styles = StyleSheet.create({
  header: {
    minHeight: 56,
    flexDirection: 'row',
    alignItems: 'center'
  },
  // A side never shrinks below its content; its minimum width (set inline)
  // is the wider side's content width, so both sides are equally wide.
  side: {
    flexShrink: 0
  },
  left: {
    alignItems: 'flex-start'
  },
  right: {
    alignItems: 'flex-end'
  },
  title: {
    flex: 1,
    textAlign: 'center',
    ...TYPE.headline
  },
  fill: {
    flex: 1
  },
  footer: {
    paddingTop: 8
  },
  body: {
    paddingTop: 12,
    gap: 24
  }
})
