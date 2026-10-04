/**
 * Routines list for one profile (docs/02 section 3.6, docs/10 "Settings and
 * agent details"): this profile's Hermes cron jobs, newest schedule state
 * first, with finished one-shots hidden per FR-172.
 */

import { useLocalSearchParams, useRouter } from 'expo-router'
import React, { useMemo, useState } from 'react'
import { RefreshControl, StyleSheet, Text, View } from 'react-native'

import { displayName, isActive, isFinishedOneShot, nextRunLabel, useRoutines } from '@/features/routines'
import { usePrimaryConnection } from '@/features/settings'
import { useGateway } from '@/gateway/registry'
import { userMessage } from '@/gateway/errors'
import type { CronJob } from '@/gateway/types'
import { softFill } from '@/theme/fill'
import { useTheme } from '@/theme/provider'
import { ICON, LEADING, LEGACY_RADIUS, TYPE } from '@/theme/tokens'
import { Button } from '@/ui/Button'
import { Group } from '@/ui/Group'
import { Icon } from '@/ui/icons'
import { ListRow } from '@/ui/ListRow'
import { Page } from '@/ui/Page'
import { useSurface } from '@/ui/surface-context'

export default function RoutinesScreen() {
  const { profile } = useLocalSearchParams<{ profile: string }>()
  const router = useRouter()
  const connection = usePrimaryConnection()
  if (!connection || !profile) {
    return null
  }
  return (
    <Routines
      connection={connection}
      profile={profile}
      onBack={() => router.back()}
      onOpen={id => router.push({ pathname: '/agent/[profile]/routine', params: { profile, id } })}
    />
  )
}

function Routines({
  connection,
  profile,
  onBack,
  onOpen
}: {
  connection: NonNullable<ReturnType<typeof usePrimaryConnection>>
  profile: string
  onBack: () => void
  onOpen: (id: string) => void
}) {
  const theme = useTheme()
  const gateway = useGateway(connection)
  const routines = useRoutines(gateway, connection.id, profile)
  const [refreshing, setRefreshing] = useState(false)
  const tz = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone, [])

  const jobs = (routines.data ?? []).filter(job => !isFinishedOneShot(job))

  const onRefresh = async () => {
    setRefreshing(true)
    await routines.refetch()
    setRefreshing(false)
  }

  return (
    <Page
      title="Routines"
      onBack={onBack}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void onRefresh()} />}
      footer={<Button label="New routine" accessibilityLabel="New routine" onPress={() => onOpen('new')} />}
    >
      {routines.isError ? (
        <Text style={[styles.line, { color: theme.colors.destructive }]} accessibilityRole="alert">
          {userMessage(routines.error)}
        </Text>
      ) : null}
      {jobs.length > 0 ? (
        <Group iconless>
          {jobs.map(job => (
            <RoutineRow key={job.id} job={job} profile={profile} tz={tz} onPress={() => onOpen(job.id)} />
          ))}
        </Group>
      ) : null}
      {routines.isSuccess && jobs.length === 0 ? (
        <Text style={[styles.line, { color: theme.colors.mutedForeground }]}>No routines yet. Add one to have this assistant check in on a schedule.</Text>
      ) : null}
    </Page>
  )
}

function RoutineRow({ job, profile, tz, onPress }: { job: CronJob; profile: string; tz: string; onPress: () => void }) {
  const theme = useTheme()
  // The badge sits on the group's own fill, so it takes the fill that differs from that one.
  const badgeFill = softFill(theme.colors, softFill(theme.colors, useSurface()))
  const name = displayName(job, profile)
  const paused = !isActive(job)
  const next = nextRunLabel(job, new Date(), tz)
  const label = `${name}, ${job.schedule}, ${next}${paused ? ', paused' : ''}`

  return (
    <ListRow
      title={name}
      subtitle={`${job.schedule}\n${next}`}
      accessibilityLabel={label}
      onPress={onPress}
      right={
        <View style={styles.rowRight}>
          {paused ? (
            <View style={[styles.pausedBadge, { backgroundColor: badgeFill }]}>
              <Text style={[styles.pausedText, { color: theme.colors.mutedForeground }]}>Paused</Text>
            </View>
          ) : null}
          <Icon name="chevron-right" size={ICON.chevron} color={theme.colors.mutedForeground} />
        </View>
      }
    />
  )
}

const styles = StyleSheet.create({
  rowRight: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  pausedBadge: { borderRadius: LEGACY_RADIUS.badge, paddingHorizontal: 6, paddingVertical: 2 },
  pausedText: { ...TYPE.caption },
  line: { ...TYPE.callout, lineHeight: LEADING.callout, paddingVertical: 16, textAlign: 'center' }
})
