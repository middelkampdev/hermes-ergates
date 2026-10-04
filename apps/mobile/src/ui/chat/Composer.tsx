/**
 * Composer (docs/10 "Chat"): Attach, rounded "Ask <Name>" input, Mic when
 * empty / Send when text exists; Return inserts a newline; voice recording
 * has a visible state and a cancel control.
 */

import React, { useState } from 'react'
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native'

import type { PendingAttachment } from '@/features/files'
import { useTheme } from '@/theme/provider'
import { LEGACY_RADIUS, TYPE } from '@/theme/tokens'
import { Icon } from '@/ui/icons'
import { IconButton } from '@/ui/IconButton'

/** The Send/Mic disc is 38pt and the chip 32pt tall; slop lifts both to the 44pt contract (docs/10 section 4). */
const DISC_HIT_SLOP = 3
const CHIP_HIT_SLOP = 6
const SEND_SIZE = 38
const RECORDING_DOT_SIZE = 10
/** The attachment disclosure sits tighter than the footnote leading. */
const DISCLOSURE_LINE_HEIGHT = 16

export interface ComposerProps {
  name: string
  value: string
  onChangeText: (text: string) => void
  onSend: () => void
  onAttach: () => void
  onMicStart: () => void
  onMicStop: () => void
  onMicCancel: () => void
  recording: boolean
  interim?: string
  attachments: PendingAttachment[]
  onRemoveAttachment: (id: string) => void
  disabled?: boolean
  disclosure?: string | null
  /** Development smoke tests only: focus the field on mount. */
  autoFocus?: boolean
}

export function Composer(p: ComposerProps) {
  const theme = useTheme()
  const [focused, setFocused] = useState(false)
  const hasText = p.value.trim().length > 0 || p.attachments.some(a => a.state === 'attached')
  return (
    <View style={styles.wrap}>
      {p.attachments.length > 0 ? (
        <View style={styles.chips}>
          {p.attachments.map(a => (
            <Pressable key={a.id} onPress={() => p.onRemoveAttachment(a.id)} hitSlop={CHIP_HIT_SLOP} accessibilityRole="button" accessibilityLabel={`Remove ${a.name}`} style={[styles.chip, { backgroundColor: theme.colors.muted, borderColor: a.state === 'failed' ? theme.colors.destructive : theme.colors.border }]}>
              <Icon name={a.kind === 'image' ? 'image' : 'file'} size={14} color={theme.colors.mutedForeground} />
              <Text style={[styles.chipText, { color: a.state === 'failed' ? theme.colors.destructive : theme.colors.foreground }]} numberOfLines={1}>
                {a.name}
                {a.state === 'attaching' ? ' …' : a.state === 'failed' ? ` (${a.error ?? 'failed'})` : ''}
              </Text>
              <Icon name="x" size={14} color={theme.colors.mutedForeground} />
            </Pressable>
          ))}
        </View>
      ) : null}
      {p.recording ? (
        <View style={[styles.recording, { backgroundColor: theme.colors.accent, borderRadius: theme.radius.composer }]} accessibilityLiveRegion="polite">
          <View style={[styles.dot, { backgroundColor: theme.colors.primary }]} />
          <Text style={[styles.recordingText, { color: theme.colors.foreground }]} numberOfLines={2}>
            {p.interim?.trim() ? p.interim : 'Listening…'}
          </Text>
          <IconButton name="x" accessibilityLabel="Cancel recording" onPress={p.onMicCancel} />
          <IconButton name="check" accessibilityLabel="Use this text" filled onPress={p.onMicStop} />
        </View>
      ) : (
        <View style={styles.row}>
          <IconButton name="plus" accessibilityLabel="Attach" onPress={p.onAttach} disabled={p.disabled} />
          <View style={[styles.inputWrap, { backgroundColor: theme.colors.input, borderColor: focused ? theme.colors.midground : theme.colors.border, borderRadius: theme.radius.composer }]}>
            <TextInput
              value={p.value}
              onChangeText={p.onChangeText}
              autoFocus={p.autoFocus}
              placeholder={`Ask ${p.name}`}
              placeholderTextColor={theme.colors.mutedForeground}
              multiline
              textAlignVertical="center"
              blurOnSubmit={false}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              editable={!p.disabled}
              accessibilityLabel={`Message ${p.name}`}
              style={[styles.input, { color: theme.colors.foreground }]}
            />
            {hasText ? (
              <Pressable onPress={p.onSend} disabled={p.disabled} hitSlop={DISC_HIT_SLOP} accessibilityRole="button" accessibilityLabel="Send" style={[styles.send, { backgroundColor: theme.colors.primary }]}>
                <Icon name="arrow-up" size={20} color={theme.colors.primaryForeground} />
              </Pressable>
            ) : (
              <Pressable onPress={p.onMicStart} disabled={p.disabled} hitSlop={DISC_HIT_SLOP} accessibilityRole="button" accessibilityLabel="Voice input" style={[styles.send, { backgroundColor: theme.colors.muted }]}>
                <Icon name="mic" size={20} color={theme.colors.mutedForeground} />
              </Pressable>
            )}
          </View>
        </View>
      )}
      {p.disclosure ? <Text style={[styles.disclosure, { color: theme.colors.mutedForeground }]}>{p.disclosure}</Text> : null}
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: { paddingTop: 8, gap: 6 },
  row: { flexDirection: 'row', alignItems: 'flex-end', gap: 10 },
  inputWrap: { flex: 1, flexDirection: 'row', alignItems: 'flex-end', minHeight: 48, borderWidth: 1, paddingLeft: 14, paddingRight: 4, paddingTop: 4, paddingBottom: 4 },
  // One line = 20 of text + 10 above + 10 below = 40, centered in the 48 field; grows to five lines.
  input: { flex: 1, ...TYPE.body, minHeight: 40, maxHeight: 22 * 5 + 20, paddingTop: 10, paddingBottom: 10, paddingLeft: 0, paddingRight: 6 },
  send: { width: SEND_SIZE, height: SEND_SIZE, borderRadius: SEND_SIZE / 2, alignItems: 'center', justifyContent: 'center', marginBottom: 1 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 6, paddingHorizontal: 10, borderRadius: LEGACY_RADIUS.chip, borderWidth: 1, maxWidth: '100%', minHeight: 32 },
  chipText: { ...TYPE.footnote, maxWidth: 200 },
  recording: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 14, paddingRight: 4, minHeight: 48 },
  dot: { width: RECORDING_DOT_SIZE, height: RECORDING_DOT_SIZE, borderRadius: RECORDING_DOT_SIZE / 2 },
  recordingText: { flex: 1, ...TYPE.callout },
  disclosure: { ...TYPE.caption, lineHeight: DISCLOSURE_LINE_HEIGHT, paddingHorizontal: 8 }
})
