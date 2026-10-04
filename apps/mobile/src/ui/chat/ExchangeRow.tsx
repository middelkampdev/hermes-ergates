import React, { type ReactNode } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'

import { useTheme } from '@/theme/provider'
import { LEADING, RULE, SIZE, SPACE, TYPE } from '@/theme/tokens'

export interface ExchangeRowProps {
  text: string
  label: string
  openable: boolean
  marked: boolean
  onPress?: () => void
  /** Rendered avatar, e.g. `<PeerAvatar peer={...} size={SIZE.extraSmall} connectionId={...} />`. */
  avatar: ReactNode
}

/** The row is `SIZE.small` tall like `EventRow`; slop lifts the tap target to `RULE.touch` (docs/10 section 4). */
const HIT_SLOP = (RULE.touch - SIZE.small) / 2

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
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', alignSelf: 'center', maxWidth: '92%', minHeight: SIZE.small, paddingVertical: SPACE.extraSmall, gap: SPACE.extraSmall },
  text: { ...TYPE.footnote, lineHeight: LEADING.footnote, flexShrink: 1, textAlign: 'center' },
  dot: { width: SIZE.tiny, height: SIZE.tiny, borderRadius: SIZE.tiny / 2 }
})
