import React, { type ReactNode } from 'react'
import { StyleSheet, Text, View } from 'react-native'

import { useTheme } from '@/theme/provider'
import { RADIUS, SIZE, SPACE, TYPE } from '@/theme/tokens'
import { MarkdownText } from '@/ui/MarkdownText'

/** Avatar footprint (docs/10 section 4) plus the row's gap, so the author label lines up with the bubble, not the avatar. */
const AVATAR_SIZE = SIZE.small
const AVATAR_GAP = SPACE.small

export interface BotMessageBubbleProps {
  /** Peer display name shown above the bubble. */
  name: string
  text: string
  /** Accessibility label for the whole row. */
  label: string
  /** Rendered avatar, e.g. `<PeerAvatar peer={...} size={SIZE.small} connectionId={...} />`. */
  avatar: ReactNode
}

/** A message from another bot, addressed to this bot (docs 5.4): same bubble geometry as `AssistantBubble`, with the sender's name and avatar. */
export function BotMessageBubble({ name, text, label, avatar }: BotMessageBubbleProps) {
  const theme = useTheme()
  return (
    <View style={styles.wrap} accessible accessibilityLabel={label}>
      <Text style={[styles.name, { color: theme.colors.mutedForeground }]} numberOfLines={1}>
        {name}
      </Text>
      <View style={styles.row}>
        {avatar}
        <View style={[styles.bubble, { backgroundColor: theme.colors.muted, borderRadius: RADIUS.extraLarge }]}>
          <View style={styles.markdown}>
            <MarkdownText>{text}</MarkdownText>
          </View>
        </View>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: { alignSelf: 'flex-start', maxWidth: '88%', marginVertical: SPACE.extraSmall },
  name: { ...TYPE.footnote, marginBottom: SPACE.extraSmall, marginLeft: AVATAR_SIZE + AVATAR_GAP },
  row: { flexDirection: 'row', alignItems: 'flex-end', gap: AVATAR_GAP },
  bubble: { paddingVertical: SPACE.medium, paddingHorizontal: SPACE.large, flexShrink: 1 },
  // Cancels the last paragraph's bottom margin (MarkdownText's SPACE.small).
  markdown: { marginBottom: -SPACE.small }
})
