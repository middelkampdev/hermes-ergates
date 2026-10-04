/**
 * Provider / Model picker (docs/10 "Edit Bot on mobile"): only providers the
 * server is authenticated for are selectable; others are listed as needing
 * sign-in on the server. Shares the Edit Bot draft through `EditBotProvider`.
 */

import { useLocalSearchParams, useRouter } from 'expo-router'
import React, { useState } from 'react'
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native'

import { useEditBotContext, useModelOptions } from '@/features/agents'
import { usePrimaryConnection } from '@/features/settings'
import { useGateway } from '@/gateway/registry'
import type { ModelProvider } from '@/gateway/types'
import { useTheme } from '@/theme/provider'
import { ICON, LEADING, TYPE } from '@/theme/tokens'
import { Field } from '@/ui/Field'
import { Group } from '@/ui/Group'
import { Icon } from '@/ui/icons'
import { IconButton } from '@/ui/IconButton'
import { ListRow } from '@/ui/ListRow'
import { Page } from '@/ui/Page'

export default function EditModelScreen() {
  const { profile } = useLocalSearchParams<{ profile: string }>()
  const connection = usePrimaryConnection()
  if (!connection || !profile) {
    return null
  }
  return <EditModel connection={connection} profile={profile} />
}

function EditModel({ connection, profile }: { connection: NonNullable<ReturnType<typeof usePrimaryConnection>>; profile: string }) {
  const theme = useTheme()
  const router = useRouter()
  const gateway = useGateway(connection)
  const { draft, update } = useEditBotContext()
  const options = useModelOptions(gateway, connection.id, profile)
  const [expandedSlug, setExpandedSlug] = useState<string | null>(draft?.provider || null)
  const [customFor, setCustomFor] = useState<string | null>(null)

  const refresh = <IconButton name="refresh-cw" accessibilityLabel="Refresh providers" onPress={() => void options.refetch()} />

  if (!draft) {
    return (
      <Page title="Provider / Model" onBack={() => router.back()} right={refresh}>
        <ActivityIndicator style={styles.loading} color={theme.colors.foreground} />
      </Page>
    )
  }

  const providers = options.data?.providers ?? []
  const authenticated = providers.filter(p => p.authenticated)
  const unauthenticated = providers.filter(p => !p.authenticated)

  const isCustomOpen = (p: ModelProvider) =>
    customFor === p.slug || (draft.provider === p.slug && draft.model !== '' && !p.models.includes(draft.model))

  return (
    <Page title="Provider / Model" onBack={() => router.back()} right={refresh}>
      {options.isLoading ? <ActivityIndicator style={styles.loading} color={theme.colors.foreground} /> : null}
      {options.isError ? <Text style={[styles.note, { color: theme.colors.destructive }]}>Could not load providers. Tap Refresh to try again.</Text> : null}

      <Group iconless>
        <PickRow
          label="Inherit from server default"
          selected={!draft.provider && !draft.model}
          onPress={() => {
            setCustomFor(null)
            update({ provider: '', model: '' })
          }}
        />
      </Group>

      {authenticated.map(p => (
        <View key={p.slug} style={styles.provider}>
          <Group iconless>
            <ExpandRow label={p.name} expanded={expandedSlug === p.slug} onPress={() => setExpandedSlug(s => (s === p.slug ? null : p.slug))} />
            {expandedSlug === p.slug
              ? [
                  ...p.models.map(m => (
                    <PickRow
                      key={m}
                      label={m}
                      selected={draft.provider === p.slug && draft.model === m}
                      // Clear the custom row too, or both rows read as selected
                      // and the custom field stays open.
                      onPress={() => {
                        setCustomFor(null)
                        update({ provider: p.slug, model: m })
                      }}
                    />
                  )),
                  <PickRow key="custom" label="Custom model…" selected={isCustomOpen(p)} onPress={() => setCustomFor(p.slug)} />
                ]
              : null}
          </Group>
          {expandedSlug === p.slug && isCustomOpen(p) ? (
            <Field
              label="Custom model id"
              value={draft.provider === p.slug ? draft.model : ''}
              onChangeText={text => update({ provider: p.slug, model: text })}
              placeholder="e.g. gpt-5-custom"
              accessibilityLabel="Custom model id"
            />
          ) : null}
        </View>
      ))}

      {unauthenticated.length > 0 ? (
        <Text style={[styles.note, { color: theme.colors.mutedForeground }]}>Sign in on the server to use: {unauthenticated.map(p => p.name).join(', ')}</Text>
      ) : null}
    </Page>
  )
}

function ExpandRow({ label, expanded, onPress }: { label: string; expanded: boolean; onPress: () => void }) {
  const theme = useTheme()
  return (
    <ListRow
      title={label}
      expanded={expanded}
      right={<Icon name={expanded ? 'chevron-down' : 'chevron-right'} size={ICON.chevron} color={theme.colors.mutedForeground} />}
      onPress={onPress}
    />
  )
}

function PickRow({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
  const theme = useTheme()
  return (
    <ListRow
      title={label}
      selected={selected}
      right={selected ? <Icon name="check" size={ICON.row} color={theme.colors.primary} /> : <View style={styles.noCheck} />}
      onPress={onPress}
    />
  )
}

const styles = StyleSheet.create({
  loading: { marginTop: 40 },
  provider: { gap: 12 },
  noCheck: { width: ICON.row },
  note: { ...TYPE.footnote, lineHeight: LEADING.footnote }
})
