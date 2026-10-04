/**
 * Composer (docs/10 "Chat"): Attach, rounded "Ask <Name>" input, Mic when
 * empty / Send when text exists; Return inserts a newline; voice recording
 * has a visible state and a cancel control.
 */

import React, { useState } from 'react'
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native'

import type { PendingAttachment } from '@/features/files'
import { useTheme } from '@/theme/provider'
import { ICON_SIZE, LEADING, RADIUS, RULE, SIZE, SPACE, TYPE } from '@/theme/tokens'
import { Icon } from '@/ui/icons'
import { IconButton } from '@/ui/IconButton'

/** The Send/Mic disc (`SIZE.medium`) and the chip (`SIZE.small` tall) are smaller than a touch target; slop lifts both to `RULE.touch` (docs/10 section 4). */
const DISC_HIT_SLOP = (RULE.touch - SIZE.medium) / 2
const CHIP_HIT_SLOP = (RULE.touch - SIZE.small) / 2

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
              <Icon name={a.kind === 'image' ? 'image' : 'file'} size={ICON_SIZE.small} color={theme.colors.mutedForeground} />
              <Text style={[styles.chipText, { color: a.state === 'failed' ? theme.colors.destructive : theme.colors.foreground }]} numberOfLines={1}>
                {a.name}
                {a.state === 'attaching' ? ' …' : a.state === 'failed' ? ` (${a.error ?? 'failed'})` : ''}
              </Text>
              <Icon name="x" size={ICON_SIZE.small} color={theme.colors.mutedForeground} />
            </Pressable>
          ))}
        </View>
      ) : null}
      {p.recording ? (
        <View style={[styles.recording, { backgroundColor: theme.colors.accent, borderRadius: RADIUS.huge }]} accessibilityLiveRegion="polite">
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
          <View style={[styles.inputWrap, { backgroundColor: theme.colors.input, borderColor: focused ? theme.colors.midground : theme.colors.border, borderRadius: RADIUS.huge }]}>
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
                <Icon name="arrow-up" size={ICON_SIZE.medium} color={theme.colors.primaryForeground} />
              </Pressable>
            ) : (
              <Pressable onPress={p.onMicStart} disabled={p.disabled} hitSlop={DISC_HIT_SLOP} accessibilityRole="button" accessibilityLabel="Voice input" style={[styles.send, { backgroundColor: theme.colors.muted }]}>
                <Icon name="mic" size={ICON_SIZE.medium} color={theme.colors.mutedForeground} />
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
  wrap: { paddingTop: SPACE.small, gap: SPACE.extraSmall },
  row: { flexDirection: 'row', alignItems: 'flex-end', gap: SPACE.small },
  inputWrap: { flex: 1, flexDirection: 'row', alignItems: 'flex-end', minHeight: SIZE.large, borderWidth: 1, paddingLeft: SPACE.medium, paddingRight: SPACE.extraSmall, paddingTop: SPACE.extraSmall, paddingBottom: SPACE.extraSmall },
  // One line of text with SPACE.small above and below, at least SIZE.medium, in the SIZE.large field; grows to about five 22 pt lines.
  input: { flex: 1, ...TYPE.body, minHeight: SIZE.medium, maxHeight: 22 * 5 + 2 * SPACE.small, paddingTop: SPACE.small, paddingBottom: SPACE.small, paddingLeft: 0, paddingRight: SPACE.extraSmall },
  send: { width: SIZE.medium, height: SIZE.medium, borderRadius: SIZE.medium / 2, alignItems: 'center', justifyContent: 'center' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.extraSmall },
  chip: { flexDirection: 'row', alignItems: 'center', gap: SPACE.extraSmall, paddingVertical: SPACE.extraSmall, paddingHorizontal: SPACE.small, borderRadius: RADIUS.medium, borderWidth: 1, maxWidth: '100%', minHeight: SIZE.small },
  chipText: { ...TYPE.footnote, maxWidth: RULE.fileNameMaxWidth },
  recording: { flexDirection: 'row', alignItems: 'center', gap: SPACE.small, paddingLeft: SPACE.medium, paddingRight: SPACE.extraSmall, minHeight: SIZE.large },
  dot: { width: SIZE.tiny, height: SIZE.tiny, borderRadius: SIZE.tiny / 2 },
  recordingText: { flex: 1, ...TYPE.callout },
  disclosure: { ...TYPE.caption, lineHeight: LEADING.footnote, paddingHorizontal: SPACE.small }
})
