/**
 * Memory: read-only view of this profile's `MEMORY.md` and `USER.md`
 * (docs/02 section 3.10, docs/10 "Settings and agent details"). Hermes
 * writes these through the agent's `memory` tool; the app never edits them.
 */

import { useQuery } from '@tanstack/react-query'
import { useLocalSearchParams, useRouter } from 'expo-router'
import React from 'react'
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native'

import { userMessage } from '@/gateway/errors'
import { useGateway } from '@/gateway/registry'
import { usePrimaryConnection } from '@/features/settings'
import { useTheme } from '@/theme/provider'
import { LEADING, TYPE } from '@/theme/tokens'
import { Group } from '@/ui/Group'
import { MarkdownText } from '@/ui/MarkdownText'
import { Page } from '@/ui/Page'

export default function MemoryScreen() {
  const { profile } = useLocalSearchParams<{ profile: string }>()
  const router = useRouter()
  const connection = usePrimaryConnection()
  if (!connection || !profile) {
    return null
  }
  return <Memory connection={connection} profile={profile} onBack={() => router.back()} />
}

function Memory({ connection, profile, onBack }: { connection: NonNullable<ReturnType<typeof usePrimaryConnection>>; profile: string; onBack: () => void }) {
  const theme = useTheme()
  const gateway = useGateway(connection)
  const query = useQuery({
    queryKey: ['memory-files', connection.id, profile],
    queryFn: () => gateway.profiles.memory(profile)
  })

  return (
    <Page title="Memory" onBack={onBack}>
      {query.isLoading ? <ActivityIndicator style={styles.spinner} /> : null}
      {query.isError ? (
        <Text style={[styles.line, { color: theme.colors.destructive }]} accessibilityRole="alert">
          {userMessage(query.error)}
        </Text>
      ) : null}
      {query.data && !query.data.available ? (
        <Text style={[styles.line, { color: theme.colors.mutedForeground }]}>Memory files are not readable through this gateway.</Text>
      ) : null}
      {query.data?.available ? (
        <>
          <Group caption="MEMORY.md" iconless>
            <View style={styles.doc}>
              <MarkdownText>{query.data.memory.trim() ? query.data.memory : '_Empty._'}</MarkdownText>
            </View>
          </Group>
          <Group caption="USER.md" iconless>
            <View style={styles.doc}>
              <MarkdownText>{query.data.user.trim() ? query.data.user : '_Empty._'}</MarkdownText>
            </View>
          </Group>
        </>
      ) : null}
      <Text style={[styles.hint, { color: theme.colors.mutedForeground }]}>
        Ask the assistant in chat to remember or forget something; editing here is not supported.
      </Text>
    </Page>
  )
}

const styles = StyleSheet.create({
  spinner: { marginVertical: 12 },
  doc: { paddingHorizontal: 16, paddingVertical: 12 },
  hint: { ...TYPE.footnote, lineHeight: LEADING.footnote },
  line: { ...TYPE.callout, lineHeight: LEADING.callout, paddingVertical: 16, textAlign: 'center' }
})
