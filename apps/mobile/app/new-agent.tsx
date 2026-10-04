import { useQueryClient } from '@tanstack/react-query'
import { useRouter } from 'expo-router'
import React, { useState } from 'react'
import { Alert, StyleSheet, Text, View } from 'react-native'

import { createAgent, rosterKey, slugFromTitle, useModelOptions, validateCreate } from '@/features/agents'
import { usePrimaryConnection } from '@/features/settings'
import { useGateway } from '@/gateway/registry'
import { useTheme } from '@/theme/provider'
import { LEADING, TYPE } from '@/theme/tokens'
import { Button } from '@/ui/Button'
import { Field } from '@/ui/Field'
import { Group } from '@/ui/Group'
import { Icon } from '@/ui/icons'
import { ListRow } from '@/ui/ListRow'
import { Sheet } from '@/ui/Sheet'

export default function NewAgentScreen() {
  const router = useRouter()
  const connection = usePrimaryConnection()
  if (!connection) {
    return null
  }
  return <NewAgent connection={connection} onClose={() => router.back()} />
}

function NewAgent({ connection, onClose }: { connection: NonNullable<ReturnType<typeof usePrimaryConnection>>; onClose: () => void }) {
  const theme = useTheme()
  const router = useRouter()
  const client = useQueryClient()
  const gateway = useGateway(connection)
  const options = useModelOptions(gateway, connection.id, 'default')
  const [title, setTitle] = useState('')
  const [name, setName] = useState('')
  const [nameTouched, setNameTouched] = useState(false)
  const [role, setRole] = useState('')
  const [description, setDescription] = useState('')
  const [soul, setSoul] = useState('')
  const [provider, setProvider] = useState('')
  const [model, setModel] = useState('')
  const [busy, setBusy] = useState(false)

  const effectiveName = nameTouched ? name : slugFromTitle(title)
  const errors = validateCreate({ name: effectiveName, title, provider, model })
  const providers = (options.data?.providers ?? []).filter(p => p.authenticated)
  const check = (on: boolean) => (on ? <Icon name="check" size={22} color={theme.colors.primary} /> : <View style={styles.noCheck} />)

  const submit = async () => {
    setBusy(true)
    const result = await createAgent(gateway, { name: effectiveName, title, role, description, soul, provider: provider || undefined, model: model || undefined })
    setBusy(false)
    await client.invalidateQueries({ queryKey: rosterKey(connection.id) })
    if (result.error) {
      Alert.alert('Setup incomplete', `${result.error}\nSteps: ${Object.entries(result.steps).map(([k, v]) => `${k} ${v}`).join(', ')}. ${result.steps.create === 'done' ? 'The profile exists; open it from Home and finish setup in Edit Bot.' : ''}`)
      return
    }
    router.replace({ pathname: '/chat/[profile]', params: { profile: result.profile } })
  }

  return (
    <Sheet title="New Agent" onClose={onClose}>
      <Field label="Display name" value={title} onChangeText={setTitle} placeholder="Thijs" error={title && errors.title ? errors.title : undefined} />
      <Field label="Profile id" value={effectiveName} onChangeText={t => { setNameTouched(true); setName(t) }} placeholder="thijs" error={effectiveName && errors.name ? errors.name : undefined} />
      <Field label="Role (badge, optional)" value={role} onChangeText={setRole} placeholder="Bookkeeper" />
      <Field label="Description" value={description} onChangeText={setDescription} placeholder="Reads invoices and prepares reconciliation notes." multiline />
      <Field label="Instructions (optional)" value={soul} onChangeText={setSoul} placeholder="Leave empty to use the Hermes default." multiline />
      <View style={styles.groups}>
        <Group caption="Provider">
          <ListRow
            title="Inherit"
            subtitle="Use the server default"
            selected={!provider}
            right={check(!provider)}
            accessibilityLabel="Inherit provider"
            onPress={() => { setProvider(''); setModel('') }}
          />
          {providers.map(p => (
            <ListRow
              key={p.slug}
              title={p.name}
              selected={provider === p.slug}
              right={check(provider === p.slug)}
              accessibilityLabel={`Provider ${p.name}`}
              onPress={() => { setProvider(p.slug); setModel(p.models[0] ?? '') }}
            />
          ))}
        </Group>
        {provider ? (
          <Group caption="Model">
            {(providers.find(p => p.slug === provider)?.models ?? []).map(m => (
              <ListRow
                key={m}
                title={m}
                selected={model === m}
                right={check(model === m)}
                accessibilityLabel={`Model ${m}`}
                onPress={() => setModel(m)}
              />
            ))}
          </Group>
        ) : null}
      </View>
      {provider ? <Field label="Custom model id" value={model} onChangeText={setModel} error={errors.model} /> : null}
      <Text style={[styles.hint, { color: theme.colors.mutedForeground }]}>The new agent starts without copied credentials and with the default tool policy. Narrow its tools in Edit Bot › Capabilities before giving it work.</Text>
      <View style={styles.actions}>
        <Button label={busy ? 'Creating…' : 'Create agent'} onPress={() => void submit()} loading={busy} disabled={busy || Object.keys(errors).length > 0} />
      </View>
    </Sheet>
  )
}

const styles = StyleSheet.create({
  groups: { gap: 24, marginBottom: 16 },
  noCheck: { width: 22 },
  hint: { ...TYPE.footnote, lineHeight: LEADING.footnote, marginTop: 12 },
  actions: { marginTop: 16, marginBottom: 40 }
})
