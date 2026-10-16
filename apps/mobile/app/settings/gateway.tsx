/**
 * Settings › Gateway (docs/10 "Settings and agent details"): how this phone
 * signs in, which Hermes answers, and the connection id push links name.
 */

import { useQuery } from '@tanstack/react-query'
import { useRouter } from 'expo-router'
import React, { useMemo } from 'react'
import { StyleSheet, View } from 'react-native'

import { pluginRowRoute, pluginRowSubtitle, useServerCheck, type NoticeRoute } from '@/features/server'
import { gradeLabel, savedConnectionGrade, savedGradeGuide, usePrimaryConnection } from '@/features/settings'
import { useGateway } from '@/gateway/registry'
import { buildRecord } from '@/lib/build-info'
import { ICON_SIZE, SPACE } from '@/theme/tokens'
import { AutoUpdateSwitch } from '@/ui/AutoUpdateSwitch'
import { Group } from '@/ui/Group'
import { GuideLink } from '@/ui/GuideLink'
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
  const plugin = useServerCheck(connection, build)
  const pluginRoute = pluginRowRoute(plugin.data)
  const grade = savedConnectionGrade(connection)
  const guide = savedGradeGuide(grade)
  return (
    <Page title="Gateway" onBack={onBack}>
      <Group>
        <ListRow title="Sign-in" subtitle={connection.authMode === 'token' ? 'Session token' : 'Username and password'} icon="key" />
        {/* Worked out from the saved address and sign-in mode alone: this screen makes no request for it. An unsafe
            grade (a connection saved before the app graded addresses) gets the guide under the row, in the same cell. */}
        <View>
          <ListRow title="Connection" subtitle={gradeLabel(grade)} icon="shield" />
          {guide ? (
            <View style={styles.guide}>
              <GuideLink label={guide.label} url={guide.url} />
            </View>
          ) : null}
        </View>
        <ListRow title="Backend" subtitle={status.data ? `Hermes ${status.data.version}` : status.isError ? 'Unreachable' : 'Checking…'} icon="cpu" />
        {/* A plugin that cannot do its job says why here, and the row opens the screen that fixes it, or Update ready when an update is ready. */}
        <ListRow
          title="Ergates plugin"
          subtitle={pluginRowSubtitle(plugin.data, plugin.isError)}
          icon="package"
          onPress={pluginRoute ? () => onOpenSetup(pluginRoute) : undefined}
        />
        {/* Whether the app keeps the plugin up to date by itself; the row above names an update that is ready. */}
        <AutoUpdateSwitch connection={connection} inGroup />
        {/* Push links name this id; the operator sets it as `ntfy.connection_id` on the server. */}
        <ListRow title="Connection id (for push links)" subtitle={connection.id} icon="hash" />
      </Group>
    </Page>
  )
}

const styles = StyleSheet.create({
  // Under the row's text: past the row padding, the icon and the gap.
  guide: { paddingLeft: SPACE.large + ICON_SIZE.medium + SPACE.medium, paddingBottom: SPACE.small }
})
