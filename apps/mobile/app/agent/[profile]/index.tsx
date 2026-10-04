/**
 * Agent details (docs/10 "Settings and agent details"): Edit Bot first,
 * then Routines, Tools & connectors and Memory, with the same roster
 * overflow menu as Home behind the header's "more" button.
 */

import { useLocalSearchParams, useRouter } from 'expo-router'
import React, { useRef, useState } from 'react'
import { Alert, ScrollView, StyleSheet, Text, View } from 'react-native'

import { deleteAgent, useAvatar, useHome, useOrganizer, useSetHidden, type Bot } from '@/features/agents'
import { usePrimaryConnection } from '@/features/settings'
import { userMessage } from '@/gateway/errors'
import { useGateway } from '@/gateway/registry'
import { lightTap } from '@/lib/haptics'
import { useDeviceStore } from '@/state/device-store'
import { useTheme } from '@/theme/provider'
import { AVATAR, LEADING, TYPE } from '@/theme/tokens'
import type { AnchorRect } from '@/ui/ActionMenu'
import { Avatar } from '@/ui/Avatar'
import { BotActions } from '@/ui/BotActions'
import { Button } from '@/ui/Button'
import { Group } from '@/ui/Group'
import { IconButton } from '@/ui/IconButton'
import { ListRow } from '@/ui/ListRow'
import { Screen } from '@/ui/Screen'
import { useBottomInset } from '@/ui/use-bottom-inset'

export default function AgentDetailsScreen() {
  const { profile } = useLocalSearchParams<{ profile: string }>()
  const connection = usePrimaryConnection()
  if (!connection || !profile) {
    return null
  }
  return <AgentDetails connectionId={connection.id} connectionLabel={connection.label} profile={profile} />
}

const CONTENT_BOTTOM_PADDING = 40

function AgentDetails({ connectionId, connectionLabel, profile }: { connectionId: string; connectionLabel: string; profile: string }) {
  const theme = useTheme()
  const router = useRouter()
  const contentBottomInset = useBottomInset(CONTENT_BOTTOM_PADDING)
  const connection = useDeviceStore(s => s.connections.find(c => c.id === connectionId))!
  const gateway = useGateway(connection)
  const home = useHome(gateway, connectionId)
  // Per-action selectors, never `useDeviceStore()`: a whole-store subscription
  // re-rendered this screen on every unrelated store write.
  const organizer = useOrganizer(connectionId, home.rows)
  const markRead = useDeviceStore(s => s.markRead)
  const markUnread = useDeviceStore(s => s.markUnread)
  const forgetProfile = useDeviceStore(s => s.forgetProfile)
  const clearDraft = useDeviceStore(s => s.clearDraft)
  const haptics = useDeviceStore(s => s.prefs.haptics)
  const setHidden = useSetHidden(gateway, connectionId)
  const bot = home.byProfile.get(profile) ?? null
  const [menu, setMenu] = useState<{ bot: Bot; anchor: AnchorRect } | null>(null)
  const menuAnchorRef = useRef<View>(null)

  const openMenu = () => {
    if (!bot) {
      return
    }
    lightTap(haptics)
    menuAnchorRef.current?.measureInWindow((x, y, width, height) => setMenu({ bot, anchor: { x, y, width, height } }))
  }

  /** Device-local leftovers of a deleted profile, so recreating the name starts clean. */
  const forgetLocalState = (deleted: string) => {
    forgetProfile(connectionId, deleted, Date.now())
    clearDraft(connectionId, deleted)
  }

  const handlers = {
    edit: (b: Bot) => router.push({ pathname: '/agent/[profile]/edit', params: { profile: b.profile } }),
    toggleUnread: (b: Bot, unread: boolean) => (unread ? markUnread(connectionId, b.profile) : markRead(connectionId, b.profile, Date.now())),
    togglePin: (b: Bot, pinned: boolean) => (pinned ? organizer.pin([b.profile]) : organizer.unpin([b.profile])),
    moveToSection: (b: Bot, sectionId: string | null) => organizer.moveToSection([b.profile], sectionId),
    createSection: (b: Bot, name: string) => organizer.createSectionWith([b.profile], name),
    toggleHidden: (b: Bot, hidden: boolean) => setHidden.mutate({ bot: b, hidden }, { onError: err => Alert.alert('Could not update', userMessage(err)) }),
    remove: async (b: Bot) => {
      const result = await deleteAgent(gateway, b.profile, b.isDefault)
      if (result.error) {
        Alert.alert('Delete did not finish', `${result.error}\nRoutines removed: ${result.removedJobs.length}. Steps: ${Object.entries(result.steps).map(([k, v]) => `${k} ${v}`).join(', ')}.`)
        return
      }
      forgetLocalState(b.profile)
      router.replace('/')
    }
  }

  if (!bot) {
    return (
      <Screen>
        <View style={styles.header}>
          <IconButton name="chevron-left" accessibilityLabel="Back" onPress={() => router.back()} />
        </View>
        {home.loading ? (
          <Text style={{ color: theme.colors.mutedForeground }}>Loading…</Text>
        ) : home.error ? (
          <View style={styles.errorBlock}>
            <Text style={{ color: theme.colors.destructive }} accessibilityRole="alert">
              Could not load this bot.
            </Text>
            <Button label="Retry" onPress={() => void home.refetch()} accessibilityLabel="Retry" />
          </View>
        ) : (
          <Text style={{ color: theme.colors.mutedForeground }}>This bot is not on the roster.</Text>
        )}
      </Screen>
    )
  }

  return (
    <Screen edges={['top']}>
      <View style={styles.header}>
        <IconButton name="chevron-left" accessibilityLabel="Back" onPress={() => router.back()} />
        <View style={styles.headerSpacer} />
        <View ref={menuAnchorRef} collapsable={false}>
          <IconButton name="more-horizontal" accessibilityLabel="More actions" onPress={openMenu} />
        </View>
      </View>
      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: contentBottomInset }]}>
        <Identity bot={bot} gateway={gateway} connectionId={connectionId} />
        <Group>
          <ListRow title="Edit Bot" icon="edit-2" onPress={() => router.push({ pathname: '/agent/[profile]/edit', params: { profile } })} />
          <ListRow title="Routines" icon="clock" onPress={() => router.push({ pathname: '/agent/[profile]/routines', params: { profile } })} />
          <ListRow title="Tools & connectors" icon="tool" onPress={() => router.push({ pathname: '/agent/[profile]/tools', params: { profile } })} />
          <ListRow title="Memory" icon="book-open" onPress={() => router.push({ pathname: '/agent/[profile]/memory', params: { profile } })} />
          <ListRow title="Notifications" icon="bell" onPress={() => router.push({ pathname: '/notifications', params: { profile } })} />
        </Group>

        <Group caption="Details" iconless>
          <InfoRow label="Profile id" value={profile} theme={theme} />
          <InfoRow label="Model" value={bot.model || '—'} theme={theme} />
          <InfoRow label="Provider" value={bot.provider || '—'} theme={theme} />
          <InfoRow label="Description" value={bot.description || '—'} theme={theme} />
        </Group>
      </ScrollView>
      <BotActions
        bot={menu?.bot ?? null}
        anchor={menu?.anchor ?? null}
        unread={menu ? home.unread(menu.bot.profile) : false}
        pinned={menu ? home.isPinned(menu.bot.profile) : false}
        sections={home.organization.sections}
        currentSectionId={menu ? (home.sectionOf(menu.bot.profile)?.id ?? null) : null}
        connectionLabel={connectionLabel}
        handlers={handlers}
        onClose={() => setMenu(null)}
      />
    </Screen>
  )
}

function Identity({ bot, gateway, connectionId }: { bot: Bot; gateway: ReturnType<typeof useGateway>; connectionId: string }) {
  const theme = useTheme()
  const avatar = useAvatar(gateway, connectionId, bot.profile, bot.hasAvatar)
  return (
    <View style={styles.identity} accessibilityRole="header" accessibilityLabel={[bot.name, bot.role].filter(Boolean).join(', ')}>
      <Avatar name={bot.name} color={bot.color} imageUri={avatar.data ?? null} size={AVATAR.profile} />
      <Text style={[styles.identityName, { color: theme.colors.foreground }]} numberOfLines={1}>
        {bot.name}
      </Text>
      {bot.role ? (
        <Text style={[styles.identityRole, { color: theme.colors.mutedForeground }]} numberOfLines={1}>
          {bot.role}
        </Text>
      ) : null}
    </View>
  )
}

function InfoRow({ label, value, theme }: { label: string; value: string; theme: ReturnType<typeof useTheme> }) {
  return (
    <View style={styles.infoRow}>
      <Text style={[styles.infoLabel, { color: theme.colors.mutedForeground }]}>{label}</Text>
      <Text style={[styles.infoValue, { color: theme.colors.foreground }]}>{value}</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 48, marginBottom: 8, gap: 8 },
  headerSpacer: { flex: 1 },
  identity: { alignItems: 'center', gap: 8, paddingTop: 8, paddingBottom: 4 },
  identityName: { ...TYPE.title },
  identityRole: { ...TYPE.callout },
  errorBlock: { gap: 12, alignItems: 'flex-start', marginTop: 24 },
  content: { paddingTop: 8, gap: 24 },
  infoRow: { gap: 2, paddingHorizontal: 16, paddingVertical: 14 },
  infoLabel: { ...TYPE.footnote },
  infoValue: { ...TYPE.callout, lineHeight: LEADING.callout }
})
