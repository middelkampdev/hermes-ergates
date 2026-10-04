import { useFocusEffect, useRouter, Redirect } from 'expo-router'
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Alert, BackHandler, StyleSheet, Text } from 'react-native'

import {
  NO_SELECTION,
  buildEditItems,
  collapseSelection,
  deleteAgent,
  editBarLabels,
  hideEach,
  hideFailureMessage,
  liveSelection,
  membershipChanged,
  membershipSnapshot,
  profilesParam,
  selectedInListOrder,
  toggleSelected,
  useHome,
  useOrganizer,
  useOrgSync,
  useSetHidden,
  type Bot,
  type MembershipSnapshot,
  type Selection
} from '@/features/agents'
import { usePrimaryConnection } from '@/features/settings'
import { userMessage } from '@/gateway/errors'
import { useGateway } from '@/gateway/registry'
import { lightTap } from '@/lib/haptics'
import { useDeviceStore } from '@/state/device-store'
import { useTheme } from '@/theme/provider'
import { useSkinStore } from '@/theme/skin-store'
import { LEADING, TYPE } from '@/theme/tokens'
import type { AnchorRect } from '@/ui/ActionMenu'
import { BotActions } from '@/ui/BotActions'
import { EditBar, editBarHeight } from '@/ui/home-list/EditBar'
import { HomeList } from '@/ui/home-list/HomeList'
import { HomeTopBar } from '@/ui/home-list/HomeTopBar'
import { useLayoutEditing, useShowProgress } from '@/ui/home-list/motion'
import { Screen, usePagePadding } from '@/ui/Screen'
import { useBottomInset } from '@/ui/use-bottom-inset'

export default function HomeScreen() {
  const connection = usePrimaryConnection()
  if (!connection) {
    return <Redirect href="/connect" />
  }
  return <Home connectionId={connection.id} connectionLabel={connection.label} />
}

const LIST_BOTTOM_PADDING = 40

function Home({ connectionId, connectionLabel }: { connectionId: string; connectionLabel: string }) {
  const theme = useTheme()
  const router = useRouter()
  // The roster list scrolls to the bottom edge of the phone; its content
  // carries the inset instead of Screen reserving a strip for it.
  const listBottomInset = useBottomInset(LIST_BOTTOM_PADDING)
  // The bottom bar is a fixed overlay, not part of the flex layout, so while
  // it is up the list reserves its height (the bar's own inset included) on
  // top of the list's usual end margin, so the last row can scroll clear of it.
  const barBottomInset = useBottomInset()
  // The error and empty lines sit in the edge-to-edge list, padded like its rows.
  const gutter = usePagePadding()
  // Guarded by `HomeScreen`, which redirects to /connect without a connection.
  const connection = useDeviceStore(s => s.connections.find(c => c.id === connectionId))!
  const gateway = useGateway(connection)
  const home = useHome(gateway, connectionId)
  // Per-action selectors, never `useDeviceStore()`: the whole-store selector
  // re-rendered this screen (and its whole roster list) on every keystroke
  // typed in the chat below it. Action references are stable.
  const organizer = useOrganizer(connectionId, home.rows)
  const syncWithHermes = useDeviceStore(s => s.syncWithHermes)
  // Sends queued pin and section changes to Hermes (docs/05 "Organization outbox").
  useOrgSync(gateway, connectionId, home, message => Alert.alert('Could not update', message))
  const markRead = useDeviceStore(s => s.markRead)
  const markUnread = useDeviceStore(s => s.markUnread)
  const markManyRead = useDeviceStore(s => s.markManyRead)
  const markManyUnread = useDeviceStore(s => s.markManyUnread)
  const toggleCollapsed = useDeviceStore(s => s.toggleCollapsed)
  const forgetProfile = useDeviceStore(s => s.forgetProfile)
  const clearDraft = useDeviceStore(s => s.clearDraft)
  const haptics = useDeviceStore(s => s.prefs.haptics)
  const setHidden = useSetHidden(gateway, connectionId)
  const setActiveConnection = useSkinStore(s => s.setActiveConnection)
  const [menu, setMenu] = useState<{ bot: Bot; anchor: AnchorRect } | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  // Edit mode (docs/10 "Home edit mode"). Every change applies at once, so
  // leaving only clears the selection; there is nothing to cancel. The same
  // list stays on screen: circles, handles and badges animate in and out.
  const [editing, setEditing] = useState(false)
  const progress = useShowProgress(editing)
  const layoutEditing = useLayoutEditing(editing, progress)
  const [picked, setPicked] = useState<Selection>(NO_SELECTION)
  const items = useMemo(() => buildEditItems(home), [home])
  const selection = liveSelection(picked, items)
  const selected = selectedInListOrder(items, selection)
  const labels = editBarLabels(selected, { isPinned: home.isPinned, isUnread: home.unread })

  const startEditing = (profile?: string) => {
    setPicked(profile ? new Set([profile]) : NO_SELECTION)
    setEditing(true)
  }
  const stopEditing = () => {
    setEditing(false)
    setPicked(NO_SELECTION)
  }

  // Move to Section (bottom bar "Move to…"): the selection survives the trip.
  // Backing out without picking anything is not an action, so it stays; once
  // Home regains focus, it clears only if one of the selected agents actually
  // moved (docs/10 "Home edit mode": the selection clears after an action).
  const pendingMove = useRef<MembershipSnapshot | null>(null)
  useFocusEffect(
    useCallback(() => {
      const pending = pendingMove.current
      if (!pending) {
        return
      }
      pendingMove.current = null
      if (membershipChanged(pending, home.organization)) {
        setPicked(NO_SELECTION)
      }
    }, [home.organization])
  )

  // Android Back leaves Edit mode instead of leaving Home.
  useFocusEffect(
    useCallback(() => {
      if (!editing) {
        return
      }
      const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
        setEditing(false)
        setPicked(NO_SELECTION)
        return true
      })
      return () => subscription.remove()
    }, [editing])
  )

  const refetchHome = home.refetch
  useFocusEffect(
    useCallback(() => {
      setActiveConnection(connectionId)
      void gateway.restore().then(() => refetchHome())
    }, [connectionId, gateway, refetchHome, setActiveConnection])
  )

  // Every roster read (docs/05 section 3): the one-time first sync (on a new
  // install, the concierge pin when Hermes has no value for it), then new
  // agents at the top of their group, the pin order and sections only Hermes knows.
  const rows = home.rows
  useEffect(() => {
    syncWithHermes(connectionId, rows)
  }, [rows, connectionId, syncWithHermes])

  const openChat = (bot: Bot) => {
    markRead(connectionId, bot.profile, Date.now())
    router.push({ pathname: '/chat/[profile]', params: { profile: bot.profile } })
  }

  const editSection = (sectionId: string) => router.push({ pathname: '/section', params: { id: sectionId } })

  const openMenu = (bot: Bot, anchor: AnchorRect) => {
    lightTap(haptics)
    setMenu({ bot, anchor })
  }

  /** Device-local leftovers of a deleted profile, so recreating the name starts clean. */
  const forgetLocalState = (profile: string) => {
    forgetProfile(connectionId, profile, Date.now())
    clearDraft(connectionId, profile)
  }

  const handlers = {
    edit: (bot: Bot) => {
      // Details first, so the editor is a real sheet with the bot's page beneath it.
      router.push({ pathname: '/agent/[profile]', params: { profile: bot.profile } })
      router.push({ pathname: '/agent/[profile]/edit', params: { profile: bot.profile } })
    },
    toggleUnread: (bot: Bot, unread: boolean) => (unread ? markUnread(connectionId, bot.profile) : markRead(connectionId, bot.profile, Date.now())),
    togglePin: (bot: Bot, pinned: boolean) => (pinned ? organizer.pin([bot.profile]) : organizer.unpin([bot.profile])),
    moveToSection: (bot: Bot, sectionId: string | null) => organizer.moveToSection([bot.profile], sectionId),
    createSection: (bot: Bot, name: string) => organizer.createSectionWith([bot.profile], name),
    select: (bot: Bot) => startEditing(bot.profile),
    toggleHidden: (bot: Bot, hidden: boolean) => setHidden.mutate({ bot, hidden }, { onError: err => Alert.alert('Could not update', userMessage(err)) }),
    remove: async (bot: Bot) => {
      const result = await deleteAgent(gateway, bot.profile, bot.isDefault)
      if (result.error) {
        Alert.alert('Delete did not finish', `${result.error}\nRoutines removed: ${result.removedJobs.length}. Steps: ${Object.entries(result.steps).map(([k, v]) => `${k} ${v}`).join(', ')}.`)
      } else {
        forgetLocalState(bot.profile)
      }
      await home.refetch()
    }
  }

  // After each bottom bar action the selection clears and Edit mode stays open.
  // Move to… is the exception: it clears only once it actually moves someone
  // (see the pendingMove focus effect above), so backing out keeps the pick.
  const bar = {
    move: () => {
      pendingMove.current = membershipSnapshot(home.organization, selected)
      router.push({ pathname: '/move-to-section', params: { profiles: profilesParam(selected) } })
    },
    pin: () => {
      if (labels.pin === 'Unpin') {
        organizer.unpin(selected)
      } else {
        organizer.pin(selected)
      }
      setPicked(NO_SELECTION)
    },
    hide: async () => {
      const bots = selected.map(profile => home.byProfile.get(profile)).filter((bot): bot is Bot => Boolean(bot))
      setPicked(NO_SELECTION)
      const failed = await hideEach(bots, bot => setHidden.mutateAsync({ bot, hidden: true }))
      if (failed.length > 0) {
        Alert.alert('Could not hide', hideFailureMessage(failed))
      }
    },
    read: () => {
      if (labels.read === 'Mark read') {
        markManyRead(connectionId, selected, Date.now())
      } else {
        markManyUnread(connectionId, selected)
      }
      setPicked(NO_SELECTION)
    }
  }

  const onRefresh = async () => {
    setRefreshing(true)
    await home.refetch()
    setRefreshing(false)
  }

  const empty = !home.loading && !home.error && home.bots.length === 0

  return (
    <Screen>
      <HomeTopBar
        editing={editing}
        progress={progress}
        selectedCount={selection.size}
        onSettings={() => router.push('/settings')}
        onEdit={() => startEditing()}
        onDone={stopEditing}
        onSearch={() => router.push('/search')}
        onAdd={() => router.push('/new-agent')}
      />
      <HomeList
        items={items}
        selection={selection}
        editing={editing}
        layoutEditing={layoutEditing}
        progress={progress}
        gateway={gateway}
        connectionId={connectionId}
        haptics={haptics}
        unread={home.unread}
        refreshing={refreshing}
        onRefresh={() => void onRefresh()}
        onOpen={openChat}
        onMenu={openMenu}
        onToggle={profile => setPicked(toggleSelected(selection, profile))}
        onSelectionChange={setPicked}
        onMove={organizer.applyMove}
        onToggleCollapsed={sectionId => {
          setPicked(collapseSelection(picked, home, sectionId))
          toggleCollapsed(connectionId, sectionId)
        }}
        onEditSection={editSection}
        bottomPadding={editing && selection.size > 0 ? editBarHeight(theme, barBottomInset) + LIST_BOTTOM_PADDING : listBottomInset}
        bottomCover={editing && selection.size > 0 ? editBarHeight(theme, barBottomInset) : 0}
        header={
          home.error ? (
            <Text style={[styles.line, { color: theme.colors.destructive, paddingHorizontal: gutter }]} accessibilityRole="alert">
              Could not load your assistants. Pull to retry.
            </Text>
          ) : null
        }
        footer={empty ? <Text style={[styles.line, { color: theme.colors.mutedForeground, paddingHorizontal: gutter }]}>No assistants yet. Tap + to create one.</Text> : null}
      />
      <EditBar labels={labels} shown={editing && selection.size > 0} onMove={bar.move} onPin={bar.pin} onHide={() => void bar.hide()} onRead={bar.read} />
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

const styles = StyleSheet.create({
  line: { ...TYPE.callout, lineHeight: LEADING.callout, paddingVertical: 24, textAlign: 'center' }
})
