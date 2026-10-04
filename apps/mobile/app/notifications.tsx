/**
 * Notification settings for one agent, or for all agents (`?profile=*`)
 * (docs/11 section 4.2): mute, and quiet hours that hold routine pushes until
 * they end. Stored on the server through the Ergates route; the form rules
 * live in `src/features/attention/prefs.ts`.
 */

import { useLocalSearchParams, useRouter } from 'expo-router'
import React, { useEffect, useState } from 'react'
import { ActivityIndicator, Alert, StyleSheet, Text, View } from 'react-native'

import { draftFromPrefs, prefsFromDraft, scopeLabel, useAttentionPrefs, type PrefsDraft } from '@/features/attention'
import { usePrimaryConnection } from '@/features/settings'
import { userMessage } from '@/gateway/errors'
import { useGateway } from '@/gateway/registry'
import { useTheme } from '@/theme/provider'
import { LEADING, TYPE } from '@/theme/tokens'
import { Button } from '@/ui/Button'
import { Card } from '@/ui/Card'
import { Field } from '@/ui/Field'
import { Sheet } from '@/ui/Sheet'
import { SwitchRow } from '@/ui/SwitchRow'

export default function NotificationsScreen() {
  const { profile } = useLocalSearchParams<{ profile: string }>()
  const router = useRouter()
  const connection = usePrimaryConnection()
  if (!connection || !profile) {
    return null
  }
  return <Notifications connection={connection} profile={profile} onClose={() => router.back()} />
}

function Notifications({ connection, profile, onClose }: { connection: NonNullable<ReturnType<typeof usePrimaryConnection>>; profile: string; onClose: () => void }) {
  const theme = useTheme()
  const gateway = useGateway(connection)
  const { prefs, save } = useAttentionPrefs(gateway, connection.id, profile)
  const [draft, setDraft] = useState<PrefsDraft | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (prefs.data && draft === null) {
      setDraft(draftFromPrefs(prefs.data))
    }
  }, [prefs.data, draft])

  const onSave = async () => {
    if (!draft) {
      return
    }
    const next = prefsFromDraft(profile, draft)
    if ('error' in next) {
      setError(next.error)
      return
    }
    setError(null)
    try {
      await save.mutateAsync(next.prefs)
      onClose()
    } catch (err) {
      Alert.alert('Could not save', userMessage(err))
    }
  }

  const title = profile === '*' ? 'Notifications' : `Notifications: ${scopeLabel(profile)}`
  return (
    <Sheet title={title} onClose={onClose}>
      {prefs.isError ? (
        <Text style={[styles.line, { color: theme.colors.destructive }]} accessibilityRole="alert">
          {userMessage(prefs.error)}
        </Text>
      ) : !draft ? (
        <ActivityIndicator style={styles.spinner} />
      ) : (
        <>
          <Card>
            <SwitchRow
              label="Mute"
              description={profile === '*' ? 'No push for any agent without its own setting.' : 'No push from this agent.'}
              value={draft.muted}
              onValueChange={muted => setDraft({ ...draft, muted })}
            />
            <SwitchRow label="Quiet hours" description="Routine pushes wait until they end. Approvals always come through." value={draft.quiet} onValueChange={quiet => setDraft({ ...draft, quiet })} />
          </Card>
          {draft.quiet ? (
            <View style={styles.times}>
              <Field label="From" value={draft.start} onChangeText={start => setDraft({ ...draft, start })} placeholder="22:00" keyboardType="numbers-and-punctuation" />
              <Field label="Until" value={draft.end} onChangeText={end => setDraft({ ...draft, end })} placeholder="07:00" keyboardType="numbers-and-punctuation" error={error ?? undefined} />
              <Text style={[styles.hint, { color: theme.colors.mutedForeground }]}>Times are in the time zone Hermes is configured for, not this phone&apos;s.</Text>
            </View>
          ) : null}
          <View style={styles.actions}>
            <Button label="Save" onPress={() => void onSave()} loading={save.isPending} accessibilityLabel="Save notification settings" />
          </View>
        </>
      )}
    </Sheet>
  )
}

const styles = StyleSheet.create({
  line: { ...TYPE.callout, lineHeight: LEADING.callout, paddingVertical: 16, textAlign: 'center' },
  spinner: { marginVertical: 24 },
  times: { marginTop: 16 },
  hint: { ...TYPE.footnote, lineHeight: LEADING.footnote },
  actions: { marginTop: 20, marginBottom: 32 }
})
