/**
 * Tools & connectors: read-only view of this profile's toolsets, MCP
 * connectors and skills (docs/02 section 3.7, docs/10 "Settings and agent
 * details"). Changes are made in Edit Bot › Capabilities; this screen only
 * inspects current/effective state and lets the user test a connector.
 */

import { useQuery } from '@tanstack/react-query'
import { useLocalSearchParams, useRouter } from 'expo-router'
import React, { useState } from 'react'
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native'

import { useDescribe } from '@/features/agents'
import { usePrimaryConnection } from '@/features/settings'
import { userMessage } from '@/gateway/errors'
import { useGateway } from '@/gateway/registry'
import type { DescribeSkill, DescribeToolset, McpServerRow } from '@/gateway/types'
import { useTheme } from '@/theme/provider'
import { LEADING, TYPE } from '@/theme/tokens'
import { Button } from '@/ui/Button'
import { Group } from '@/ui/Group'
import { ListRow } from '@/ui/ListRow'
import { Page } from '@/ui/Page'

type TestState = 'testing' | 'ok' | 'failed'

export default function ToolsScreen() {
  const { profile } = useLocalSearchParams<{ profile: string }>()
  const router = useRouter()
  const connection = usePrimaryConnection()
  if (!connection || !profile) {
    return null
  }
  return (
    <Tools
      connection={connection}
      profile={profile}
      onBack={() => router.back()}
      // Edit goes through Edit Bot, not straight to the capabilities subpage:
      // Save and the dirty guard live on `edit.tsx`, so a direct push would
      // silently discard the staged change.
      onEditCapabilities={() => router.push({ pathname: '/agent/[profile]/edit', params: { profile } })}
    />
  )
}

function Tools({
  connection,
  profile,
  onBack,
  onEditCapabilities
}: {
  connection: NonNullable<ReturnType<typeof usePrimaryConnection>>
  profile: string
  onBack: () => void
  onEditCapabilities: () => void
}) {
  const theme = useTheme()
  const gateway = useGateway(connection)
  const describe = useDescribe(gateway, connection.id, profile)
  const toolsetsQuery = useQuery({
    queryKey: ['tool-catalog', connection.id, profile],
    queryFn: () => gateway.tools.toolsets(profile)
  })
  const mcpQuery = useQuery({
    queryKey: ['mcp-servers', connection.id, profile],
    queryFn: () => gateway.tools.mcpServers(profile)
  })
  const [testState, setTestState] = useState<Record<string, TestState>>({})

  const onTest = async (name: string) => {
    setTestState(s => ({ ...s, [name]: 'testing' }))
    try {
      const result = await gateway.tools.testMcp(name, profile)
      setTestState(s => ({ ...s, [name]: result.ok ? 'ok' : 'failed' }))
    } catch {
      setTestState(s => ({ ...s, [name]: 'failed' }))
    }
  }

  const toolNamesFor = (name: string): string[] | null => {
    if (!toolsetsQuery.isSuccess) {
      return null
    }
    return toolsetsQuery.data.find(t => t.name === name)?.tools ?? []
  }

  return (
    <Page
      title="Tools & connectors"
      onBack={onBack}
      right={<Button label="Edit" variant="ghost" accessibilityLabel="Edit tools and connectors in Edit Bot capabilities" onPress={onEditCapabilities} />}
    >
      <Text style={[styles.hint, { color: theme.colors.mutedForeground }]}>
        Changes take effect on the assistant&apos;s next session; a saved change is not an immediate revocation.
      </Text>

      {describe.isLoading ? <ActivityIndicator style={styles.spinner} /> : null}
      {describe.isError ? (
        <Text style={[styles.line, { color: theme.colors.destructive }]} accessibilityRole="alert">
          {userMessage(describe.error)}
        </Text>
      ) : null}

      <Group caption="Toolsets">
        {(describe.data?.toolsets ?? []).map(ts => (
          <ToolsetRow key={ts.name} toolset={ts} tools={toolNamesFor(ts.name)} />
        ))}
        {describe.isSuccess && (describe.data?.toolsets.length ?? 0) === 0 ? <EmptyRow text="No toolsets configured." /> : null}
      </Group>

      <Group caption="Connectors">
        {(mcpQuery.data ?? []).map(server => (
          <ConnectorRow key={server.name} server={server} state={testState[server.name]} onTest={() => void onTest(server.name)} />
        ))}
        {mcpQuery.isError ? <EmptyRow text={userMessage(mcpQuery.error)} /> : null}
        {mcpQuery.isSuccess && (mcpQuery.data?.length ?? 0) === 0 ? <EmptyRow text="No connectors configured." /> : null}
      </Group>

      <Group caption="Skills">
        {(describe.data?.skills ?? []).map(skill => (
          <SkillRow key={skill.name} skill={skill} />
        ))}
        {describe.isSuccess && (describe.data?.skills.length ?? 0) === 0 ? <EmptyRow text="No skills assigned." /> : null}
      </Group>
    </Page>
  )
}

function StateBadge({ on }: { on: boolean }) {
  const theme = useTheme()
  return <Text style={[styles.stateBadge, { color: on ? theme.colors.primary : theme.colors.mutedForeground }]}>{on ? 'On' : 'Off'}</Text>
}

function EmptyRow({ text }: { text: string }) {
  const theme = useTheme()
  return (
    <View style={styles.emptyRow}>
      <Text style={[styles.emptyText, { color: theme.colors.mutedForeground }]}>{text}</Text>
    </View>
  )
}

function ToolsetRow({ toolset }: { toolset: DescribeToolset; tools: string[] | null }) {
  // Count plus the server's own summary; the full tool list lives on the Capabilities page.
  const subtitle = [`${toolset.tool_count} tool${toolset.tool_count === 1 ? '' : 's'}`, toolset.description].filter(Boolean).join(' · ')
  return <ListRow title={toolset.label} subtitle={subtitle} right={<StateBadge on={toolset.enabled} />} />
}

function ConnectorRow({ server, state, onTest }: { server: McpServerRow; state: TestState | undefined; onTest: () => void }) {
  const enabled = server.enabled !== false
  const transport = typeof server.transport === 'string' ? server.transport : 'unknown transport'
  const resultText = state === 'testing' ? 'Testing…' : state === 'ok' ? 'Connected' : state === 'failed' ? 'Failed' : null
  return (
    <ListRow
      title={server.name}
      subtitle={state === 'failed' || !resultText ? transport : `${transport}\n${resultText}`}
      error={state === 'failed' ? (resultText ?? undefined) : undefined}
      right={
        <View style={styles.connectorRight}>
          <StateBadge on={enabled} />
          <Button label="Test" variant="secondary" loading={state === 'testing'} accessibilityLabel={`Test ${server.name}`} onPress={onTest} />
        </View>
      }
    />
  )
}

function SkillRow({ skill }: { skill: DescribeSkill }) {
  return <ListRow title={skill.name} right={<StateBadge on={skill.enabled} />} />
}

const styles = StyleSheet.create({
  hint: { ...TYPE.footnote, lineHeight: LEADING.footnote },
  spinner: { marginVertical: 12 },
  emptyRow: { minHeight: 44, paddingVertical: 12, paddingHorizontal: 16 },
  emptyText: { ...TYPE.footnote, lineHeight: LEADING.footnote },
  stateBadge: { ...TYPE.footnoteStrong },
  connectorRight: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  line: { ...TYPE.callout, lineHeight: LEADING.callout, paddingVertical: 16, textAlign: 'center' }
})
