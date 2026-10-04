/**
 * The body of a conversation row, shared by `Row` (Search) and `HomeRow`
 * (Home): the avatar slot, the name line (name, optional role badge, time) and
 * the one-line preview with the unread dot. It owns no press handling, height
 * or gutter; the row around it does.
 *
 * `trailingStyle` goes on the time's wrapper and on the unread dot, so a row
 * can slide both together (Home does in Edit mode). `maxFontScale` caps the
 * system text size for rows with a fixed height.
 */

import type { ComponentProps, ReactNode } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import Animated from 'react-native-reanimated'

import { useTheme } from '@/theme/provider'
import { LEGACY_RADIUS, TYPE } from '@/theme/tokens'

const BADGE_MAX_WIDTH = 113
const UNREAD_DOT_SIZE = 8

export interface RowContentProps {
  name: string
  avatar: ReactNode
  role?: string
  time?: string
  /** `undefined` draws an empty line; a string, even an empty one, draws the text. */
  preview?: string
  unread?: boolean
  maxFontScale?: number
  trailingStyle?: ComponentProps<typeof Animated.View>['style']
}

export function RowContent({ name, avatar, role, time, preview, unread, maxFontScale, trailingStyle }: RowContentProps) {
  const theme = useTheme()

  return (
    <View style={styles.content}>
      {avatar}
      <View style={styles.body}>
        <View style={styles.line}>
          <Text numberOfLines={1} maxFontSizeMultiplier={maxFontScale} style={[styles.name, { color: theme.colors.foreground }]}>
            {name}
          </Text>
          {role ? (
            <Text
              numberOfLines={1}
              maxFontSizeMultiplier={maxFontScale}
              style={[styles.badge, { color: theme.colors.mutedForeground, backgroundColor: theme.colors.muted }]}
            >
              {role}
            </Text>
          ) : null}
          {time ? (
            <Animated.View style={trailingStyle}>
              <Text numberOfLines={1} maxFontSizeMultiplier={maxFontScale} style={[styles.time, { color: theme.colors.mutedForeground }]}>
                {time}
              </Text>
            </Animated.View>
          ) : null}
        </View>
        <View style={styles.line}>
          {preview !== undefined ? (
            <Text numberOfLines={1} maxFontSizeMultiplier={maxFontScale} style={[styles.preview, { color: theme.colors.mutedForeground }]}>
              {preview}
            </Text>
          ) : (
            <View style={styles.preview} />
          )}
          {unread ? (
            <Animated.View
              // Decorative: an `accessible` container hides its descendants on
              // iOS, so the state is carried by the row's own label instead.
              accessible={false}
              style={[styles.unreadDot, { backgroundColor: theme.colors.primary }, trailingStyle]}
            />
          ) : null}
        </View>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  content: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 12 },
  body: { flex: 1, gap: 2 },
  line: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  name: { flex: 1, ...TYPE.bodyStrong },
  badge: {
    ...TYPE.caption,
    borderRadius: LEGACY_RADIUS.badge,
    maxWidth: BADGE_MAX_WIDTH,
    paddingHorizontal: 6,
    paddingVertical: 2,
    overflow: 'hidden'
  },
  time: { ...TYPE.caption },
  preview: { flex: 1, ...TYPE.callout },
  unreadDot: { width: UNREAD_DOT_SIZE, height: UNREAD_DOT_SIZE, borderRadius: UNREAD_DOT_SIZE / 2 }
})
