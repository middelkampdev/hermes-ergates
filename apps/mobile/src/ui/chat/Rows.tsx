import React from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'

import type { ChatItem } from '@/features/chat'
import { useTheme } from '@/theme/provider'
import { LEADING, RADIUS, TYPE } from '@/theme/tokens'
import { Icon, type IconName } from '@/ui/icons'

/** Compact centered event row (routine created, renamed, messaged X). */
export function EventRow({ text, icon = 'zap' }: { text: string; icon?: IconName }) {
  const theme = useTheme()
  return (
    <View style={styles.event} accessibilityLabel={text}>
      <Icon name={icon} size={14} color={theme.colors.mutedForeground} />
      <Text style={[styles.eventText, { color: theme.colors.mutedForeground }]} numberOfLines={2}>
        {text}
      </Text>
    </View>
  )
}

/**
 * Assistant commentary emitted alongside tool calls (`message.interim`). It is
 * not the answer — the answer arrives as deltas and a completion — so it reads
 * as a muted aside rather than a bubble.
 */
export function CommentaryRow({ text }: { text: string }) {
  const theme = useTheme()
  return (
    <View style={styles.commentary} accessible accessibilityLabel={`Note: ${text}`}>
      <Text style={[styles.commentaryText, { color: theme.colors.mutedForeground }]}>{text}</Text>
    </View>
  )
}

export function DateSeparator({ label }: { label: string }) {
  const theme = useTheme()
  return <Text style={[styles.date, { color: theme.colors.mutedForeground }]}>{label}</Text>
}

type ToolItem = Extract<ChatItem, { kind: 'tool' }>

/**
 * Quiet one-line tool row; details live behind Activity. `text` is the
 * timeline's visible line and is rendered exactly as given: tool arguments,
 * commands and paths must never reach the timeline (docs/04), so a caller that
 * supplies `text` gets no detail suffix. The computed fallback is kept only for
 * a caller with no timeline behind it.
 */
export function ToolRow({ item, onPress, label, text }: { item: ToolItem; onPress?: () => void; label?: string; text?: string }) {
  const theme = useTheme()
  const computedLabel = item.done ? `Used ${item.name}` : `Using ${item.name}…`
  const detail = item.context || (item.args ? Object.values(item.args).map(v => (typeof v === 'string' ? v : JSON.stringify(v))).join(' ') : '')
  const visible = text ?? `${computedLabel}${detail ? ` · ${detail.slice(0, 60)}` : ''}`
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole={onPress ? 'button' : undefined}
      accessibilityLabel={label ?? text ?? `${computedLabel}${detail ? `, ${detail}` : ''}`}
      style={styles.event}
    >
      <Icon name={item.error ? 'alert-circle' : item.done ? 'check' : 'loader'} size={14} color={item.error ? theme.colors.destructive : theme.colors.mutedForeground} />
      <Text style={[styles.eventText, { color: theme.colors.mutedForeground }]} numberOfLines={1}>
        {visible}
      </Text>
    </Pressable>
  )
}

/** The timeline is the one producer of working-line copy (`workingLineText`, spec 5.9); this only renders it. */
export function WorkingLine({ text, onStop }: { text: string; onStop: () => void }) {
  const theme = useTheme()
  return (
    <View style={styles.working} accessibilityLiveRegion="polite">
      <View style={[styles.dot, { backgroundColor: theme.colors.primary }]} />
      <Text style={[styles.workingText, { color: theme.colors.mutedForeground }]} numberOfLines={1}>
        {text}
      </Text>
      <Pressable onPress={onStop} accessibilityRole="button" accessibilityLabel="Stop" hitSlop={12} style={styles.stop}>
        <Text style={[styles.stopText, { color: theme.colors.primary }]}>Stop</Text>
      </Pressable>
    </View>
  )
}

export function ConnectionLine({ state }: { state: 'idle' | 'connecting' | 'open' | 'closed' | 'error' }) {
  const theme = useTheme()
  if (state === 'open' || state === 'idle') {
    return null
  }
  const text = state === 'connecting' ? 'Connecting…' : state === 'closed' ? 'Connection lost. Reconnecting…' : 'Connection error. Check the gateway or sign in again.'
  return (
    <View style={[styles.connection, { backgroundColor: theme.colors.muted }]} accessibilityLiveRegion="polite">
      <Text style={[styles.connectionText, { color: state === 'error' ? theme.colors.destructive : theme.colors.mutedForeground }]}>{text}</Text>
    </View>
  )
}

const DOT_SIZE = 8

const styles = StyleSheet.create({
  event: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 6, minHeight: 32, alignSelf: 'center', maxWidth: '92%' },
  eventText: { ...TYPE.footnote, lineHeight: LEADING.footnote, flexShrink: 1, textAlign: 'center' },
  commentary: { alignSelf: 'flex-start', maxWidth: '88%', paddingVertical: 4, paddingHorizontal: 4 },
  commentaryText: { ...TYPE.callout, lineHeight: LEADING.callout, fontStyle: 'italic' },
  date: { ...TYPE.footnote, textAlign: 'center', marginVertical: 12 },
  working: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8, minHeight: 44 },
  dot: { width: DOT_SIZE, height: DOT_SIZE, borderRadius: DOT_SIZE / 2 },
  workingText: { ...TYPE.callout, flex: 1 },
  stop: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 8 },
  stopText: { ...TYPE.calloutStrong },
  connection: { paddingVertical: 6, paddingHorizontal: 12, borderRadius: RADIUS.small, alignSelf: 'center', marginVertical: 6 },
  connectionText: { ...TYPE.footnote }
})
