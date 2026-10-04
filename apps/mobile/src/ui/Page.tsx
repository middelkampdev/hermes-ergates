/**
 * A pushed page (docs/10 section 4): a back chevron on the left, the title
 * centered, an optional action on the right, and a scrolling body that moves
 * clear of the keyboard. Settings' sub-pages and Move to Section use it.
 *
 * `variant: 'modal'` is for a page that is the root of a modal sheet
 * (Settings): the same header and body, but a close ✕ instead of the back
 * chevron, matching the other sheets' close control.
 */

import type { ReactElement, ReactNode } from 'react'
import { KeyboardAvoidingView, Platform, ScrollView, type RefreshControlProps, StyleSheet, Text, View } from 'react-native'

import { useTheme } from '@/theme/provider'
import { TYPE } from '@/theme/tokens'

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
  return (
    <Screen edges={['top']}>
      <View style={styles.header}>
        <View style={styles.side}>
          <IconButton name={variant === 'modal' ? 'x' : 'chevron-left'} accessibilityLabel={variant === 'modal' ? 'Close' : 'Back'} onPress={onBack} />
        </View>
        <Text numberOfLines={1} accessibilityRole="header" style={[styles.title, { color: theme.colors.foreground }]}>
          {title}
        </Text>
        <View style={[styles.side, styles.right]}>{right ?? null}</View>
      </View>
      <KeyboardAvoidingView style={styles.fill} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView style={styles.fill} keyboardShouldPersistTaps="handled" refreshControl={refreshControl} contentContainerStyle={[styles.body, { paddingBottom: bottomInset }]}>
          {children}
        </ScrollView>
        {footer ? <View style={[styles.footer, { backgroundColor: theme.colors.background, paddingBottom: footerInset }]}>{footer}</View> : null}
      </KeyboardAvoidingView>
    </Screen>
  )
}

const styles = StyleSheet.create({
  header: {
    minHeight: 56,
    flexDirection: 'row',
    alignItems: 'center'
  },
  side: {
    minWidth: 44,
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
