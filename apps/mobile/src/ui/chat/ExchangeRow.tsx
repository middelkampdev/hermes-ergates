import React, { type ReactNode } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'

import { useTheme } from '@/theme/provider'
import { LEADING, TYPE } from '@/theme/tokens'

export interface ExchangeRowProps {
  text: string
  label: string
  openable: boolean
  marked: boolean
  onPress?: () => void
  /** Rendered avatar, e.g. `<PeerAvatar peer={...} size={18} connectionId={...} />`. */
  avatar: ReactNode
}

/** The row is 32 pt tall like `EventRow`; slop lifts the tap target to the 44 pt contract (docs/10 section 4). */
const HIT_SLOP = 8
const DOT_SIZE = 6

/**
 * One-line summary of a bot-to-bot exchange in the timeline (docs 5.4), in the reference's
 * compact event style: centered, small muted text, a small avatar inline; a primary-color dot
 * marks unacknowledged activity (spec 12.1). Only `text` (visible) and `label` (accessibility)
 * are ever rendered — never any detail derived from `onPress` or the exchange state itself
 * (ADR-027, docs/04).
 */
export function ExchangeRow({ text, label, openable, marked, onPress, avatar }: ExchangeRowProps) {
  const theme = useTheme()
  const content = (
    <>
      {marked ? <View style={[styles.dot, { backgroundColor: theme.colors.primary }]} /> : null}
      {avatar}
      <Text style={[styles.text, { color: theme.colors.mutedForeground }]} numberOfLines={2}>
        {text}
      </Text>
    </>
  )

  if (openable && onPress) {
    return (
      <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label} hitSlop={HIT_SLOP} style={styles.row}>
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
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', alignSelf: 'center', maxWidth: '92%', minHeight: 32, paddingVertical: 6, gap: 6 },
  text: { ...TYPE.footnote, lineHeight: LEADING.footnote, flexShrink: 1, textAlign: 'center' },
  dot: { width: DOT_SIZE, height: DOT_SIZE, borderRadius: DOT_SIZE / 2 }
})
