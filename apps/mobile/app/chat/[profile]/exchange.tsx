import { useLocalSearchParams, useRouter } from 'expo-router'
import React, { useCallback, useMemo } from 'react'
import { FlatList, StyleSheet, Text, View, type ListRenderItemInfo } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { exchangeTranscript, peerKey, useChatSession, useExchangeAcknowledgement, type TranscriptEntry } from '@/features/chat'
import { useTheme } from '@/theme/provider'
import { LEADING, RADIUS, SIZE, SPACE, TYPE } from '@/theme/tokens'
import { Avatar } from '@/ui/Avatar'
import { Button } from '@/ui/Button'
import { PeerAvatar } from '@/ui/chat/PeerAvatar'
import { DateSeparator } from '@/ui/chat/Rows'
import { IconButton } from '@/ui/IconButton'
import { MARKDOWN_PARAGRAPH_SPACING, MarkdownText } from '@/ui/MarkdownText'
import { usePagePadding } from '@/ui/Screen'
import { useFontScaleKey } from '@/ui/use-font-scale-key'
import { useBottomInset } from '@/ui/use-bottom-inset'

const AVATAR_SIZE = SIZE.small

/**
 * The read-only record of the messages this bot exchanged with one peer
 * (spec 6). Every body comes from the same timeline the chat renders — no
 * second source, no composer, no actions (ADR-027), and no receipt, command or
 * path text: those stay in Activity (docs/04).
 */
export default function ExchangeScreen() {
  const { peer, anchorRowId, anchorToolCallId } = useLocalSearchParams<{ profile: string; peer: string; anchorRowId?: string; anchorToolCallId?: string }>()
  if (!peer) {
    return null
  }
  return <ExchangeTranscript peer={peer} anchorRowId={anchorRowId} anchorToolCallId={anchorToolCallId} />
}

function ExchangeTranscript({ peer, anchorRowId, anchorToolCallId }: { peer: string; anchorRowId?: string; anchorToolCallId?: string }) {
  const theme = useTheme()
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const fontScaleKey = useFontScaleKey()
  // The transcript list scrolls to the bottom edge of the phone; its content
  // carries the inset instead of the screen reserving a strip for it.
  const listBottomInset = useBottomInset(SPACE.extraLarge)
  const gutter = usePagePadding()
  const { connectionId, profile, bot, name, avatarUri, timeline, transcript } = useChatSession()

  const anchor = useMemo(() => {
    const value: { rowId?: number; toolCallId?: string } = {}
    if (anchorRowId) {
      value.rowId = Number(anchorRowId)
    }
    if (anchorToolCallId) {
      value.toolCallId = anchorToolCallId
    }
    return value
  }, [anchorRowId, anchorToolCallId])

  const { entries, anchorKey } = useMemo(() => exchangeTranscript(timeline, { peerKey: peer, anchor }), [timeline, peer, anchor])
  // The roster display name, never the profile id or the handle (5.4 copy).
  const peerName = useMemo(() => timeline.exchanges.find(exchange => peerKey(exchange.peer) === peer)?.peer.display.name ?? peer, [timeline.exchanges, peer])

  const anchorIndex = useMemo(() => (anchorKey === undefined ? -1 : entries.findIndex(entry => entry.key === anchorKey)), [anchorKey, entries])

  // Acknowledgement (spec 12.1) and the reveal state machine live in the feature hook (ADR-029).
  const { visibleEntries, firstVisible, revealEarlier, loadOlder } = useExchangeAcknowledgement({
    entries,
    anchorIndex,
    connectionId,
    profile,
    loadOlder: transcript.loadOlder
  })

  const renderEntry = useCallback(
    ({ item: entry }: ListRenderItemInfo<TranscriptEntry>) => {
      if (entry.kind === 'time') {
        return <DateSeparator label={entry.label} />
      }
      // `author` is `'self' | PeerRef`; keep the narrowed reference, a boolean would not narrow it.
      const peerAuthor = entry.author === 'self' ? null : entry.author
      const self = peerAuthor === null
      const avatar = peerAuthor === null ? <Avatar name={name} color={bot?.color} imageUri={avatarUri} size={AVATAR_SIZE} /> : <PeerAvatar peer={peerAuthor} size={AVATAR_SIZE} connectionId={connectionId} />
      return (
        <View style={[styles.wrap, self ? styles.wrapSelf : styles.wrapPeer]} accessible accessibilityLabel={entry.label}>
          <Text style={[styles.author, self ? styles.authorSelf : styles.authorPeer, { color: theme.colors.mutedForeground }]} numberOfLines={1}>
            {entry.roleLabel}
          </Text>
          <View style={[styles.row, self ? styles.rowSelf : null]}>
            {self ? null : avatar}
            <View style={[styles.bubble, { backgroundColor: self ? theme.colors.userBubble : theme.colors.muted, borderRadius: RADIUS.extraLarge }]}>
              <View style={styles.markdown}>
                <MarkdownText>{entry.text}</MarkdownText>
              </View>
            </View>
            {self ? avatar : null}
          </View>
          {entry.stateText ? <Text style={[styles.state, self ? styles.authorSelf : styles.authorPeer, { color: theme.colors.mutedForeground }]}>{entry.stateText}</Text> : null}
        </View>
      )
    },
    [name, bot?.color, avatarUri, connectionId, theme.colors.mutedForeground, theme.colors.userBubble, theme.colors.muted]
  )

  // One line at a time: a failed page says so, a complete window says so, and
  // only a window that can still be paged offers the control.
  const header = (
    <View style={styles.listHeader}>
      {firstVisible > 0 ? (
        <Button label="Older messages" variant="secondary" onPress={revealEarlier} />
      ) : transcript.status === 'error' ? (
        <Text style={[styles.state, styles.stateCenter, { color: theme.colors.mutedForeground }]}>Older messages could not be loaded.</Text>
      ) : transcript.window.reachedStart ? (
        <Text style={[styles.state, styles.stateCenter, { color: theme.colors.mutedForeground }]}>This is the start of the recorded chat.</Text>
      ) : (
        <Button label="Older messages" variant="secondary" onPress={loadOlder} disabled={transcript.status === 'loading'} />
      )}
    </View>
  )

  return (
    <View key={fontScaleKey} style={[styles.screen, { backgroundColor: theme.colors.background, paddingTop: insets.top }]}>
      <View style={[styles.header, { paddingHorizontal: gutter, borderBottomColor: theme.colors.border, backgroundColor: theme.colors.background }]}>
        <IconButton name="chevron-left" accessibilityLabel="Back" onPress={() => router.back()} />
        <View style={styles.titleBlock}>
          <Text style={[styles.title, { color: theme.colors.foreground }]} numberOfLines={1}>
            {`Messages with ${peerName}`}
          </Text>
          <Text style={[styles.subtitle, { color: theme.colors.mutedForeground }]} numberOfLines={2}>
            {`Recorded in ${name}'s chat · grouped by exchange`}
          </Text>
        </View>
        <View style={[styles.pill, { backgroundColor: theme.colors.muted }]}>
          <Text style={[styles.pillText, { color: theme.colors.mutedForeground }]}>Read-only</Text>
        </View>
      </View>
      <FlatList
        data={visibleEntries}
        keyExtractor={entry => entry.key}
        renderItem={renderEntry}
        ListHeaderComponent={header}
        contentContainerStyle={{ paddingHorizontal: gutter, paddingTop: SPACE.extraLarge, paddingBottom: listBottomInset }}
        maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', gap: SPACE.small, minHeight: SIZE.large, paddingBottom: SPACE.small, borderBottomWidth: StyleSheet.hairlineWidth },
  titleBlock: { flex: 1, gap: SPACE.hairline },
  title: { ...TYPE.bodyStrong },
  subtitle: { ...TYPE.footnote },
  pill: { borderRadius: RADIUS.medium, paddingVertical: SPACE.extraSmall, paddingHorizontal: SPACE.small },
  pillText: { ...TYPE.footnote },
  listHeader: { paddingBottom: SPACE.medium, gap: SPACE.small },
  wrap: { maxWidth: '88%', marginVertical: SPACE.extraSmall },
  wrapPeer: { alignSelf: 'flex-start' },
  wrapSelf: { alignSelf: 'flex-end' },
  author: { ...TYPE.footnote, marginBottom: SPACE.extraSmall },
  authorPeer: { marginLeft: AVATAR_SIZE + SPACE.small },
  authorSelf: { marginRight: AVATAR_SIZE + SPACE.small, textAlign: 'right' },
  row: { flexDirection: 'row', alignItems: 'flex-end', gap: SPACE.small },
  rowSelf: { justifyContent: 'flex-end' },
  bubble: { paddingVertical: SPACE.medium, paddingHorizontal: SPACE.large, flexShrink: 1 },
  // Cancels the last paragraph's bottom margin.
  markdown: { marginBottom: -MARKDOWN_PARAGRAPH_SPACING },
  state: { ...TYPE.footnote, lineHeight: LEADING.footnote, marginTop: SPACE.extraSmall },
  stateCenter: { textAlign: 'center' }
})
