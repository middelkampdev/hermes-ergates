/**
 * Routines list for one profile (docs/02 section 3.6, docs/10 "Settings and
 * agent details"): this profile's Hermes cron jobs, newest schedule state
 * first, with finished one-shots hidden per FR-172.
 */

import { useLocalSearchParams, useRouter } from 'expo-router'
import React, { useMemo, useState } from 'react'
import { RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native'

import { displayName, isActive, isFinishedOneShot, nextRunLabel, useRoutines } from '@/features/routines'
import { usePrimaryConnection } from '@/features/settings'
import { useGateway } from '@/gateway/registry'
import { userMessage } from '@/gateway/errors'
import type { CronJob } from '@/gateway/types'
import { softFill } from '@/theme/fill'
import { useTheme } from '@/theme/provider'
import { ICON, LEADING, RADIUS, TYPE } from '@/theme/tokens'
import { Button } from '@/ui/Button'
import { Group } from '@/ui/Group'
import { Icon } from '@/ui/icons'
import { IconButton } from '@/ui/IconButton'
import { ListRow } from '@/ui/ListRow'
import { Screen } from '@/ui/Screen'
import { useSurface } from '@/ui/surface-context'
import { useBottomInset } from '@/ui/use-bottom-inset'

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
  // The list ends at the fixed footer below it, so it needs no safe-area inset.
  const listBottomPadding = 24
  // A fixed bottom bar: it pads its own content by the inset instead of
  // relying on Screen to reserve a strip for it.
  const footerBottomInset = useBottomInset(16)

  const jobs = (routines.data ?? []).filter(job => !isFinishedOneShot(job))

  const onRefresh = async () => {
    setRefreshing(true)
    await routines.refetch()
    setRefreshing(false)
  }

  return (
    <Screen>
      <View style={styles.header}>
        <IconButton name="chevron-left" accessibilityLabel="Back" onPress={onBack} />
        <Text style={[styles.headerTitle, { color: theme.colors.foreground }]} numberOfLines={1}>
          Routines
        </Text>
      </View>
      <ScrollView
        contentContainerStyle={[styles.list, { paddingBottom: listBottomPadding }]}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void onRefresh()} />}
      >
        {routines.isError ? (
          <Text style={[styles.line, { color: theme.colors.destructive }]} accessibilityRole="alert">
            {userMessage(routines.error)}
          </Text>
        ) : null}
        {jobs.length > 0 ? (
          <Group caption="Routines">
            {jobs.map(job => (
              <RoutineRow key={job.id} job={job} profile={profile} tz={tz} onPress={() => onOpen(job.id)} />
            ))}
          </Group>
        ) : null}
        {routines.isSuccess && jobs.length === 0 ? (
          <Text style={[styles.line, { color: theme.colors.mutedForeground }]}>No routines yet. Add one to have this assistant check in on a schedule.</Text>
        ) : null}
      </ScrollView>
      <View style={[styles.footer, { paddingBottom: footerBottomInset }]}>
        <Button label="New routine" accessibilityLabel="New routine" onPress={() => onOpen('new')} />
      </View>
    </Screen>
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
  header: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 48, marginBottom: 8 },
  headerTitle: { flex: 1, ...TYPE.title3 },
  list: { gap: 4 },
  footer: { paddingTop: 8 },
  rowRight: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  pausedBadge: { borderRadius: RADIUS.badge, paddingHorizontal: 6, paddingVertical: 2 },
  pausedText: { ...TYPE.caption },
  line: { ...TYPE.callout, lineHeight: LEADING.callout, paddingVertical: 16, textAlign: 'center' }
})
