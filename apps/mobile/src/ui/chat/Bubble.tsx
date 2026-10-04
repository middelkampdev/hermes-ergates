import React from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'

import type { ChatItem } from '@/features/chat'
import { formatClock } from '@/lib/time'
import { useTheme } from '@/theme/provider'
import { LEADING, RADIUS, SPACE, TYPE } from '@/theme/tokens'
import { MarkdownText } from '@/ui/MarkdownText'

type UserItem = Extract<ChatItem, { kind: 'user' }>
type AssistantItem = Extract<ChatItem, { kind: 'assistant' }>

export function AssistantBubble({ item, streaming }: { item: AssistantItem; streaming?: boolean }) {
  const theme = useTheme()
  return (
    <View style={styles.leftWrap} accessibilityLabel={`Assistant: ${item.text}`}>
      <View style={[styles.bubble, { backgroundColor: theme.colors.muted, borderRadius: RADIUS.extraLarge }]}>
        {/* Cancels the last paragraph's bottom margin so a one-line reply is 24 + 2 x 12 tall, like a user bubble. */}
        <View style={styles.markdown}>
          <MarkdownText>{item.text}</MarkdownText>
        </View>
        {streaming ? <Text style={[styles.cursor, { color: theme.colors.midground }]}>▍</Text> : null}
        {item.error ? <Text style={[styles.meta, { color: theme.colors.destructive }]}>{item.error}</Text> : null}
      </View>
    </View>
  )
}

export function StreamingBubble({ text }: { text: string }) {
  const theme = useTheme()
  return (
    <View style={styles.leftWrap}>
      <View style={[styles.bubble, { backgroundColor: theme.colors.muted, borderRadius: RADIUS.extraLarge }]}>
        <Text style={[styles.body, { color: theme.colors.foreground }]}>
          {/* Models often open with blank lines; Markdown drops them in the final bubble, so the live one must too. */}
          {text.replace(/^\s+/, '')}
          <Text style={{ color: theme.colors.midground }}>▍</Text>
        </Text>
      </View>
    </View>
  )
}

const DELIVERY_TEXT: Record<NonNullable<UserItem['delivery']>, string | null> = {
  submitting: 'Sending…',
  acknowledged: null,
  // Accepted by the gateway but parked behind the running turn — sent, so no
  // retry affordance.
  queued: 'Queued behind the current turn.',
  unconfirmed: 'Delivery unconfirmed. Check the history above, then tap to retry.',
  failed: 'Not sent. Tap to retry.',
  queued_unsent: 'Waiting for connection.'
}

export function UserBubble({ item, onRetry, showTime }: { item: UserItem; onRetry?: (localId: string) => void; showTime?: boolean }) {
  const theme = useTheme()
  const delivery = item.delivery ?? 'acknowledged'
  const note = DELIVERY_TEXT[delivery]
  const retryable = (delivery === 'unconfirmed' || delivery === 'failed') && item.localId && onRetry
  return (
    <View style={styles.rightWrap} accessibilityLabel={`You: ${item.text}`}>
      <View style={[styles.bubble, { backgroundColor: theme.colors.userBubble, borderRadius: RADIUS.extraLarge }]}>
        <Text style={[styles.body, { color: theme.colors.foreground }]}>{item.text}</Text>
      </View>
      {note ? (
        <Pressable disabled={!retryable} onPress={() => item.localId && onRetry?.(item.localId)} accessibilityRole={retryable ? 'button' : undefined} accessibilityLabel={retryable ? `${note} Retry` : note} hitSlop={8}>
          <Text style={[styles.meta, { color: delivery === 'failed' ? theme.colors.destructive : theme.colors.mutedForeground }]}>{note}</Text>
        </Pressable>
      ) : showTime && item.at ? (
        <Text style={[styles.meta, { color: theme.colors.mutedForeground }]}>{formatClock(item.at > 1e12 ? item.at / 1000 : item.at)}</Text>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  leftWrap: { alignItems: 'flex-start', maxWidth: '88%', alignSelf: 'flex-start', marginVertical: SPACE.extraSmall },
  rightWrap: { alignItems: 'flex-end', maxWidth: '88%', alignSelf: 'flex-end', marginVertical: SPACE.extraSmall },
  bubble: { paddingVertical: SPACE.medium, paddingHorizontal: SPACE.large },
  markdown: { marginBottom: -SPACE.small },
  body: { ...TYPE.body, lineHeight: LEADING.body },
  cursor: { ...TYPE.body, lineHeight: LEADING.body },
  meta: { ...TYPE.footnote, lineHeight: LEADING.footnote, marginTop: SPACE.extraSmall, marginHorizontal: SPACE.small }
})
