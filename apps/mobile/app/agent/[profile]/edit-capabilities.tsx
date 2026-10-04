/**
 * Capabilities: Skills, Toolsets and Connectors, staged in the Edit Bot
 * draft (docs/10 "Edit Bot on mobile"). Shares the draft through
 * `EditBotProvider`; nothing here calls the gateway directly.
 */

import { useRouter } from 'expo-router'
import React, { useState } from 'react'
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native'

import { useEditBotContext } from '@/features/agents'
import { useTheme } from '@/theme/provider'
import { LEADING, TYPE } from '@/theme/tokens'
import { Field } from '@/ui/Field'
import { Group } from '@/ui/Group'
import { ListRow } from '@/ui/ListRow'
import { Page } from '@/ui/Page'
import { Toggle } from '@/ui/SwitchRow'

export default function EditCapabilitiesScreen() {
  const theme = useTheme()
  const router = useRouter()
  const { draft, errors, update } = useEditBotContext()
  const [query, setQuery] = useState('')

  if (!draft) {
    return (
      <Page title="Capabilities" onBack={() => router.back()}>
        <ActivityIndicator style={styles.loading} color={theme.colors.foreground} />
      </Page>
    )
  }

  const base = draft.base.describe
  const q = query.trim().toLowerCase()
  const matches = (...names: string[]) => q === '' || names.some(n => n.toLowerCase().includes(q))

  const skills = base.skills.filter(s => matches(s.name))
  const toolsets = base.toolsets.filter(t => matches(t.name, t.label))
  const mcpServers = base.mcp_servers.filter(m => matches(m.name))

  const enabledToolsets = draft.enabledToolsets ?? base.toolsets.filter(t => t.enabled).map(t => t.name)
  const enabledMcp = draft.enabledMcp ?? base.mcp_servers.filter(m => m.enabled !== false).map(m => m.name)

  const toggleSkill = (name: string, on: boolean) => {
    const disabled = new Set(draft.disabledSkills)
    if (on) {
      disabled.delete(name)
    } else {
      disabled.add(name)
    }
    update({ disabledSkills: [...disabled] })
  }

  const toggleToolset = (name: string, on: boolean) => {
    const set = new Set(enabledToolsets)
    if (on) {
      set.add(name)
    } else {
      set.delete(name)
    }
    update({ enabledToolsets: [...set] })
  }

  const toggleMcp = (name: string, on: boolean) => {
    const set = new Set(enabledMcp)
    if (on) {
      set.add(name)
    } else {
      set.delete(name)
    }
    update({ enabledMcp: [...set] })
  }

  return (
    <Page title="Capabilities" onBack={() => router.back()}>
      {/* Field's own bottom margin would stack on the page gap. */}
      <View style={styles.search}>
        <Field
          value={query}
          onChangeText={setQuery}
          placeholder="Search skills, toolsets and connectors"
          accessibilityLabel="Search capabilities"
        />
      </View>

      <Group caption="Skills" iconless>
        {skills.length > 0 ? (
          skills.map(s => (
            <ListRow
              key={s.name}
              title={s.name}
              right={<Toggle value={!draft.disabledSkills.includes(s.name)} onValueChange={on => toggleSkill(s.name, on)} accessibilityLabel={`${s.name} skill`} />}
            />
          ))
        ) : (
          <EmptyRow text="No matching skills." />
        )}
      </Group>

      <Group caption="Toolsets" iconless>
        {toolsets.length > 0 ? (
          toolsets.map(t => (
            <ListRow
              key={t.name}
              title={t.label}
              subtitle={`${t.description} (${t.tool_count} ${t.tool_count === 1 ? 'tool' : 'tools'})`}
              right={<Toggle value={enabledToolsets.includes(t.name)} onValueChange={on => toggleToolset(t.name, on)} accessibilityLabel={`${t.label} toolset`} />}
            />
          ))
        ) : (
          <EmptyRow text="No matching toolsets." />
        )}
      </Group>
      {errors.toolsets ? <Text style={[styles.error, { color: theme.colors.destructive }]}>{errors.toolsets}</Text> : null}

      <Group caption="Connectors" iconless>
        {mcpServers.length > 0 ? (
          mcpServers.map(m => (
            <ListRow
              key={m.name}
              title={m.name}
              right={<Toggle value={enabledMcp.includes(m.name)} onValueChange={on => toggleMcp(m.name, on)} accessibilityLabel={`${m.name} connector`} />}
            />
          ))
        ) : (
          <EmptyRow text="No matching connectors." />
        )}
      </Group>

      <Text style={[styles.note, { color: theme.colors.mutedForeground }]}>Changes take effect on the assistant&apos;s next session.</Text>
    </Page>
  )
}

function EmptyRow({ text }: { text: string }) {
  const theme = useTheme()
  return (
    <View style={styles.emptyRow}>
      <Text style={[styles.empty, { color: theme.colors.mutedForeground }]}>{text}</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  loading: { marginTop: 40 },
  search: { marginBottom: -12 },
  emptyRow: { paddingVertical: 12, paddingHorizontal: 16 },
  empty: { ...TYPE.callout, lineHeight: LEADING.callout },
  error: { ...TYPE.footnote },
  note: { ...TYPE.footnote, lineHeight: LEADING.footnote }
})
