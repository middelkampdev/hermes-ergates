/**
 * Flat conversation row (docs/10 section 4): avatar, name, optional role
 * badge, time, one-line preview, unread dot. No card or separator — rows sit
 * directly on the page background, and the page (`Screen`/`Sheet`) owns the
 * horizontal gutter, so this component adds none unless a full-bleed list
 * passes `gutter`: then the row spans the screen width, its tap highlight
 * reaches both edges, and it pads its own content by the page padding.
 */

import { Pressable, StyleSheet } from 'react-native'

import { useTheme } from '@/theme/provider'

import { Avatar } from './Avatar'
import { ROW_AVATAR_SIZE, RowContent } from './RowContent'

/** Design floor for the row; never allowed below the shared min hit area. */
const ROW_MIN_HEIGHT = 52

export interface RowProps {
  name: string
  avatarColor?: string
  avatarImageUri?: string | null
  role?: string
  time?: string
  preview?: string
  unread?: boolean
  onPress?: () => void
  onLongPress?: () => void
  /** Horizontal padding inside the row, for a full-bleed list (see `page-padding.ts`). Default 0. */
  gutter?: number
}

export function Row({ name, avatarColor, avatarImageUri, role, time, preview, unread, onPress, onLongPress, gutter = 0 }: RowProps) {
  const theme = useTheme()

  const label = [name, role, unread ? 'unread' : '', time, preview].filter(Boolean).join(', ')

  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [
        styles.row,
        {
          minHeight: Math.max(theme.hit, ROW_MIN_HEIGHT),
          paddingHorizontal: gutter,
          backgroundColor: pressed ? theme.colors.muted : 'transparent'
        }
      ]}
    >
      <RowContent
        name={name}
        avatar={<Avatar name={name} color={avatarColor} imageUri={avatarImageUri} size={ROW_AVATAR_SIZE} />}
        role={role}
        time={time}
        preview={preview || undefined}
        unread={unread}
      />
    </Pressable>
  )
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 8
  }
})
