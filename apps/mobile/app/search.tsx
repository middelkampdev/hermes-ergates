/**
 * Focused roster search (docs/10 "Home"): close at left, the field opens
 * focused and states its scope, results reuse the Home row so avatars match.
 */

import { useRouter } from 'expo-router'
import React, { useMemo, useState } from 'react'
import { ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'

import { searchBots, useRoster } from '@/features/agents'
import { usePrimaryConnection } from '@/features/settings'
import { useGateway } from '@/gateway/registry'
import { useDeviceStore } from '@/state/device-store'
import { softFill } from '@/theme/fill'
import { useTheme } from '@/theme/provider'
import { LEADING, RADIUS, SIZE, TYPE } from '@/theme/tokens'
import { BotRow } from '@/ui/BotRow'
import { Icon } from '@/ui/icons'
import { IconButton } from '@/ui/IconButton'
import { Screen } from '@/ui/Screen'
import { useBottomInset } from '@/ui/use-bottom-inset'

export default function SearchScreen() {
  const router = useRouter()
  const connection = usePrimaryConnection()
  const [query, setQuery] = useState('')
  if (!connection) {
    return null
  }
  return <SearchBody connectionId={connection.id} query={query} setQuery={setQuery} onClose={() => router.back()} />
}

const LIST_BOTTOM_PADDING = 40

function SearchBody({ connectionId, query, setQuery, onClose }: { connectionId: string; query: string; setQuery: (q: string) => void; onClose: () => void }) {
  const theme = useTheme()
  const router = useRouter()
  const bottomInset = useBottomInset(LIST_BOTTOM_PADDING)
  // The parent guards on the connection existing, so this is always found; the
  // `!` keeps the hook order stable without a fabricated `baseUrl: ''` record.
  const saved = useDeviceStore(s => s.connections.find(c => c.id === connectionId))!
  const gateway = useGateway(saved)
  const roster = useRoster(gateway, connectionId)
  const results = useMemo(() => searchBots((roster.data ?? []).filter(b => !b.hidden), query), [roster.data, query])

  return (
    <Screen>
      <View style={styles.bar}>
        <IconButton name="x" accessibilityLabel="Close search" onPress={onClose} />
        <View style={[styles.field, { backgroundColor: softFill(theme.colors, theme.colors.background) }]}>
          <Icon name="search" size={18} color={theme.colors.mutedForeground} />
          <TextInput
            autoFocus
            value={query}
            onChangeText={setQuery}
            placeholder="Search by name, role or description"
            placeholderTextColor={theme.colors.mutedForeground}
            accessibilityLabel="Search assistants by name, role or description. Roster only."
            style={[styles.input, { color: theme.colors.foreground }]}
            returnKeyType="search"
            clearButtonMode="while-editing"
          />
        </View>
      </View>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: bottomInset }}>
        {results.map(bot => (
          <BotRow key={bot.profile} bot={bot} gateway={gateway} connectionId={connectionId} showTime={false} preview="description" onPress={() => router.replace({ pathname: '/chat/[profile]', params: { profile: bot.profile } })} />
        ))}
        {query.trim() && results.length === 0 ? <Text style={[styles.empty, { color: theme.colors.mutedForeground }]}>No assistant matches “{query.trim()}”. Conversation search comes later.</Text> : null}
      </ScrollView>
    </Screen>
  )
}

const styles = StyleSheet.create({
  // `paddingTop` matches the header row other sheets draw (`Sheet`'s own
  // header), so the field does not sit flush against the top safe-area inset.
  bar: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingTop: 10, marginBottom: 12 },
  field: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: SIZE.field, borderRadius: RADIUS.field, paddingHorizontal: 16 },
  input: { flex: 1, ...TYPE.body, paddingVertical: 10 },
  empty: { ...TYPE.callout, lineHeight: LEADING.callout, paddingVertical: 24, textAlign: 'center' }
})
