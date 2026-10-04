import { useRouter } from 'expo-router'
import React from 'react'
import { Alert, StyleSheet, Text, View } from 'react-native'

import { useRoster, useSetHidden } from '@/features/agents'
import { usePrimaryConnection } from '@/features/settings'
import { userMessage } from '@/gateway/errors'
import { useGateway } from '@/gateway/registry'
import { useTheme } from '@/theme/provider'
import { LEADING, LEGACY_SIZE, TYPE } from '@/theme/tokens'
import { Button } from '@/ui/Button'
import { Group } from '@/ui/Group'
import { Row } from '@/ui/Row'
import { Sheet } from '@/ui/Sheet'

export default function HiddenBotsScreen() {
  const router = useRouter()
  const connection = usePrimaryConnection()
  if (!connection) {
    return null
  }
  return <HiddenBots connection={connection} onClose={() => router.back()} />
}

function HiddenBots({ connection, onClose }: { connection: NonNullable<ReturnType<typeof usePrimaryConnection>>; onClose: () => void }) {
  const theme = useTheme()
  const gateway = useGateway(connection)
  const roster = useRoster(gateway, connection.id)
  const setHidden = useSetHidden(gateway, connection.id)
  const hidden = (roster.data ?? []).filter(b => b.hidden)
  return (
    <Sheet title="Hidden Bots" onClose={onClose}>
      <Text style={[styles.hint, { color: theme.colors.mutedForeground }]}>Hidden bots keep running and keep their routines. Unhide one to see it on Home again.</Text>
      {hidden.length > 0 ? (
        <Group iconless>
          {hidden.map(bot => (
            <View key={bot.profile} style={styles.item}>
              <View style={styles.rowBody}>
                <Row name={bot.name} role={bot.role || undefined} avatarColor={bot.color} preview={bot.description} />
              </View>
              <Button label="Unhide" variant="secondary" onPress={() => setHidden.mutate({ bot, hidden: false }, { onError: err => Alert.alert('Could not unhide', userMessage(err)) })} />
            </View>
          ))}
        </Group>
      ) : null}
      {hidden.length === 0 ? <Text style={[styles.hint, { color: theme.colors.mutedForeground }]}>No hidden bots.</Text> : null}
    </Sheet>
  )
}

const styles = StyleSheet.create({
  hint: { ...TYPE.callout, lineHeight: LEADING.callout, marginVertical: 12 },
  item: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, minHeight: LEGACY_SIZE.row },
  rowBody: { flex: 1 }
})
