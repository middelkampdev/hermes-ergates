import React from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'

import { useTheme } from '@/theme/provider'
import { LEADING, TYPE } from '@/theme/tokens'
import { Icon } from '@/ui/icons'

export interface NoticeRowProps {
  text: string
  label: string
  onPress?: () => void
}

/**
 * Compact centered notice row for the bot-to-bot timeline (docs 5.4): same
 * geometry as `EventRow` in `Rows.tsx`, with a fixed 'info' icon. Opens
 * Activity when `onPress` is given.
 */
export function NoticeRow({ text, label, onPress }: NoticeRowProps) {
  const theme = useTheme()
  const content = (
    <>
      <Icon name="info" size={14} color={theme.colors.mutedForeground} />
      <Text style={[styles.text, { color: theme.colors.mutedForeground }]} numberOfLines={2}>
        {text}
      </Text>
    </>
  )

  if (onPress) {
    return (
      <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label} hitSlop={8} style={styles.row}>
        {content}
      </Pressable>
    )
  }

  return (
    <View accessible accessibilityLabel={label} style={styles.row}>
      {content}
    </View>
  )
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 6, minHeight: 32, alignSelf: 'center', maxWidth: '92%' },
  text: { ...TYPE.footnote, lineHeight: LEADING.footnote, flexShrink: 1, textAlign: 'center' }
})
