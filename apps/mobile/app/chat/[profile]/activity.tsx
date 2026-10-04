import { useRouter } from 'expo-router'
import React, { useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'

import { useChatSession, type ActivityEntry } from '@/features/chat'
import { useTheme } from '@/theme/provider'
import { ICON_SIZE, LEADING, RADIUS, RULE, SIZE, SPACE, TYPE } from '@/theme/tokens'
import { Card } from '@/ui/Card'
import { Icon } from '@/ui/icons'
import { Sheet } from '@/ui/Sheet'

/**
 * Activity: the quiet place for tools, subagents, notices, bot-to-bot evidence
 * and available reasoning (docs/10 "Chat", spec 6). Everything it shows comes
 * from the one timeline assembly in the layout's session context; nothing is
 * computed here (ADR-029).
 *
 * This is the only screen that renders detail text, which may contain paths,
 * commands and tool arguments (docs/04). They never reach the timeline, the
 * working line or an accessibility label.
 */
export default function ActivityScreen() {
  const router = useRouter()
  const theme = useTheme()
  const { bot, profile, activity } = useChatSession()

  // Evidence first, reasoning last: what the chat did is why this screen is opened; reasoning is the
  // longest and the least often wanted, so it sits at the bottom.
  const groups: { key: ActivityEntry['kind']; title: string; entries: ActivityEntry[] }[] = [
    { key: 'exchange', title: 'Messages', entries: activity.filter(e => e.kind === 'exchange') },
    { key: 'notice', title: 'Notices', entries: activity.filter(e => e.kind === 'notice') },
    { key: 'tool', title: 'Tools', entries: activity.filter(e => e.kind === 'tool') },
    { key: 'reasoning', title: 'Reasoning', entries: activity.filter(e => e.kind === 'reasoning') }
  ]

  return (
    <Sheet title="Activity" onClose={() => router.back()}>
      <Card>
        <View style={styles.row}>
          <Text style={[styles.label, { color: theme.colors.mutedForeground }]}>Assistant</Text>
          <Text style={[styles.value, { color: theme.colors.foreground }]}>{bot?.name ?? profile}</Text>
        </View>
        <View style={styles.row}>
          <Text style={[styles.label, { color: theme.colors.mutedForeground }]}>Model</Text>
          <Text style={[styles.value, { color: theme.colors.foreground }]}>{bot?.model ?? '—'}{bot?.provider ? ` (${bot.provider})` : ''}</Text>
        </View>
        <View style={styles.row}>
          <Text style={[styles.label, { color: theme.colors.mutedForeground }]}>Bot Chat</Text>
          <Text style={[styles.value, { color: theme.colors.foreground }]}>{bot?.canonicalSessionId ?? 'not created yet'}</Text>
        </View>
      </Card>

      {groups.map(group =>
        group.entries.length === 0 ? null : (
          <View key={group.key} style={styles.group}>
            <Text style={[styles.groupTitle, { color: theme.colors.mutedForeground }]}>{group.title}</Text>
            <Card>
              {group.entries.map(entry => (entry.kind === 'reasoning' ? <ReasoningRow key={entry.id} entry={entry} /> : <DetailRow key={entry.id} entry={entry} code={entry.kind === 'tool'} />))}
            </Card>
          </View>
        )
      )}

      <Text style={[styles.hint, { color: theme.colors.mutedForeground }]}>Tool calls and requests appear as quiet rows inside the chat. Reasoning is shown only when the model makes it available; nothing is fabricated.</Text>
    </Sheet>
  )
}

/**
 * Reasoning is long and secondary: collapsed by default, the whole row toggles it. Collapsed, the row
 * shows the first line of the reasoning itself — the word "Reasoning" alone says nothing about which
 * of several rows this is — with a chevron for the state.
 */
function ReasoningRow({ entry }: { entry: ActivityEntry }) {
  const theme = useTheme()
  const [collapsed, setCollapsed] = useState(entry.collapsed)
  const firstLine = entry.detail.split('\n').find(line => line.trim().length > 0)?.trim() ?? entry.title
  return (
    <Pressable
      onPress={() => setCollapsed(c => !c)}
      accessibilityRole="button"
      accessibilityState={{ expanded: !collapsed }}
      accessibilityLabel={entry.title}
      style={[styles.entryRow, { minHeight: RULE.touch }]}
    >
      <View style={styles.reasoningHead}>
        <Text numberOfLines={1} style={[styles.title, styles.reasoningSummary, { color: theme.colors.foreground }]}>
          {firstLine}
        </Text>
        <Icon name={collapsed ? 'chevron-down' : 'chevron-up'} size={ICON_SIZE.small} color={theme.colors.mutedForeground} />
      </View>
      {collapsed ? null : <Text style={[styles.detail, { color: theme.colors.mutedForeground }]}>{entry.detail}</Text>}
    </Pressable>
  )
}

function DetailRow({ entry, code }: { entry: ActivityEntry; code?: boolean }) {
  const theme = useTheme()
  return (
    <View style={styles.entryRow} accessible accessibilityLabel={entry.title}>
      <Text style={[styles.title, { color: theme.colors.foreground }]}>{entry.title}</Text>
      {entry.detail ? (
        code ? (
          <Text style={[styles.code, { color: theme.colors.foreground, backgroundColor: theme.colors.background }]}>{entry.detail}</Text>
        ) : (
          <Text style={[styles.detail, { color: theme.colors.mutedForeground }]}>{entry.detail}</Text>
        )
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  row: { paddingVertical: SPACE.medium, paddingHorizontal: SPACE.large, gap: SPACE.hairline, minHeight: SIZE.large },
  entryRow: { paddingVertical: SPACE.medium, paddingHorizontal: SPACE.large, gap: SPACE.extraSmall, minHeight: SIZE.large },
  label: { ...TYPE.footnote },
  value: { ...TYPE.body },
  group: { marginTop: SPACE.large, gap: SPACE.extraSmall },
  groupTitle: { ...TYPE.footnote, marginLeft: SPACE.large },
  title: { ...TYPE.callout, lineHeight: LEADING.footnote },
  reasoningHead: { flexDirection: 'row', alignItems: 'center', gap: SPACE.small },
  reasoningSummary: { flexGrow: 1, flexShrink: 1, flexBasis: 'auto' },
  detail: { ...TYPE.footnote, lineHeight: LEADING.footnote },
  code: { ...TYPE.footnote, fontFamily: 'Menlo', lineHeight: LEADING.footnote, padding: SPACE.small, borderRadius: RADIUS.small },
  hint: { ...TYPE.callout, lineHeight: LEADING.callout, marginTop: SPACE.large }
})
