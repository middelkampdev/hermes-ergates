/**
 * Settings › Gateway (docs/10 "Settings and agent details"): how this phone
 * signs in, which Hermes answers, and the connection id push links name.
 */

import { useQuery } from '@tanstack/react-query'
import { useRouter } from 'expo-router'
import React, { useMemo } from 'react'

import { pluginRowSubtitle, usePluginNotice, type NoticeRoute } from '@/features/server'
import { usePrimaryConnection } from '@/features/settings'
import { useGateway } from '@/gateway/registry'
import { buildRecord } from '@/lib/build-info'
import { Group } from '@/ui/Group'
import { ListRow } from '@/ui/ListRow'
import { Page } from '@/ui/Page'

export default function GatewaySettingsScreen() {
  const router = useRouter()
  const connection = usePrimaryConnection()
  if (!connection) {
    return null
  }
  return <GatewaySettings connection={connection} onBack={() => router.back()} onOpenSetup={route => router.push(route)} />
}

interface GatewaySettingsProps {
  connection: NonNullable<ReturnType<typeof usePrimaryConnection>>
  onBack: () => void
  onOpenSetup: (route: NoticeRoute) => void
}

function GatewaySettings({ connection, onBack, onOpenSetup }: GatewaySettingsProps) {
  const gateway = useGateway(connection)
  const status = useQuery({ queryKey: ['status', connection.id], queryFn: () => gateway.status(), staleTime: 60_000 })
  const build = useMemo(() => buildRecord(), [])
  const { check: plugin, notice } = usePluginNotice(connection, build)
  const pluginAction = notice?.action ?? null
  return (
    <Page title="Gateway" onBack={onBack}>
      <Group>
        <ListRow title="Sign-in" subtitle={connection.authMode === 'token' ? 'Session token (private loopback)' : 'Username and password'} icon="key" />
        <ListRow title="Backend" subtitle={status.data ? `Hermes ${status.data.version}` : status.isError ? 'Unreachable' : 'Checking…'} icon="cpu" />
        {/* A plugin that cannot do its job says why here, and the row opens the screen that fixes it. */}
        <ListRow
          title="Ergates plugin"
          subtitle={pluginRowSubtitle(plugin.data, plugin.isError)}
          icon="package"
          onPress={pluginAction ? () => onOpenSetup(pluginAction.route) : undefined}
        />
        {/* Push links name this id; the operator sets it as `ntfy.connection_id` on the server. */}
        <ListRow title="Connection id (for push links)" subtitle={connection.id} icon="hash" />
      </Group>
    </Page>
  )
}
