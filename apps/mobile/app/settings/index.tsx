/**
 * Settings (docs/10 "Settings and agent details"): a modal sheet with the
 * connection's header, Gateway, "Make it yours", About, Developer tools
 * (development builds only) and Sign out. Every row has a line icon;
 * Gateway, Appearance and Design system open their own sub-pages, pushed
 * inside the same modal (`app/settings/_layout.tsx`), so this root
 * page gets a close ✕ instead of a back chevron (`Page`'s `variant="modal"`).
 */

import Constants from 'expo-constants'
import { useRouter } from 'expo-router'
import React from 'react'
import { Alert, StyleSheet, Text, View } from 'react-native'

import { appearanceSummary, signOut, usePrimaryConnection } from '@/features/settings'
import { useGatewayRegistry } from '@/gateway/registry'
import { useDeviceStore } from '@/state/device-store'
import { useTheme } from '@/theme/provider'
import { AVATAR, TYPE } from '@/theme/tokens'
import { listMobileThemes } from '@/theme/resolve'
import { useSkinStore } from '@/theme/skin-store'
import { Avatar } from '@/ui/Avatar'
import { Button } from '@/ui/Button'
import { Group } from '@/ui/Group'
import { ListRow } from '@/ui/ListRow'
import { Page } from '@/ui/Page'
import { Toggle } from '@/ui/SwitchRow'

const HERMES_PIN = 'd76856cc (v0.21.2)'

export default function SettingsScreen() {
  const router = useRouter()
  const connection = usePrimaryConnection()
  if (!connection) {
    return null
  }
  return <SettingsBody connection={connection} onBack={() => router.back()} />
}

function SettingsBody({ connection, onBack }: { connection: NonNullable<ReturnType<typeof usePrimaryConnection>>; onBack: () => void }) {
  const theme = useTheme()
  const router = useRouter()
  const registry = useGatewayRegistry()
  const prefs = useDeviceStore(s => s.prefs)
  const setPrefs = useDeviceStore(s => s.setPrefs)
  const backend = useSkinStore(s => s.state.backend)
  const appVersion = Constants.expoConfig?.version ?? '0.0.0'
  const address = connection.baseUrl.replace(/^https?:\/\//, '')

  const confirmSignOut = () => {
    Alert.alert('Sign out?', 'This removes the gateway from this phone, including drafts, unsent messages and pin or section changes Hermes does not have yet. Your assistants and their history stay on the server.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Sign out',
        style: 'destructive',
        onPress: async () => {
          await signOut(registry, connection)
          router.replace('/connect')
        }
      }
    ])
  }

  return (
    <Page title="Settings" onBack={onBack} variant="modal">
      <View style={styles.identity} accessible accessibilityLabel={`${connection.label}, ${address}`}>
        <Avatar name={connection.label} size={AVATAR.identity} />
        <View style={styles.identityText}>
          <Text style={[styles.name, { color: theme.colors.foreground }]} numberOfLines={1}>
            {connection.label}
          </Text>
          <Text style={[styles.address, { color: theme.colors.mutedForeground }]} numberOfLines={1}>
            {address}
          </Text>
        </View>
      </View>

      <Group>
        <ListRow title="Gateway" icon="server" onPress={() => router.push('/settings/gateway')} />
      </Group>

      <Group caption="Make it yours">
        <ListRow title="Notifications" subtitle="For all agents" icon="bell" onPress={() => router.push({ pathname: '/notifications', params: { profile: '*' } })} />
        <ListRow
          title="Appearance"
          subtitle={appearanceSummary(prefs.appearance, prefs.themeName, listMobileThemes(backend))}
          icon="moon"
          onPress={() => router.push('/settings/appearance')}
        />
        <ListRow
          title="Haptics"
          subtitle="A light tap on send and on menus."
          icon="smartphone"
          right={<Toggle value={prefs.haptics} onValueChange={haptics => setPrefs({ haptics })} accessibilityLabel="Haptics" />}
        />
        <ListRow title="Hidden bots" icon="eye-off" onPress={() => router.push('/hidden-bots')} />
      </Group>

      <Group caption="About">
        <ListRow title="Ergates" subtitle={`Version ${appVersion}`} icon="info" />
        <ListRow title="Hermes pin" subtitle={HERMES_PIN} icon="git-commit" />
        <ListRow title="Privacy" subtitle="Chats live on your gateway. This phone keeps drafts and preferences only." icon="lock" />
      </Group>

      {__DEV__ ? (
        <Group caption="Developer tools">
          <ListRow title="Design system" icon="layers" onPress={() => router.push('/settings/design-system')} />
        </Group>
      ) : null}

      <Button label="Sign out" variant="destructive" onPress={confirmSignOut} />
    </Page>
  )
}

const styles = StyleSheet.create({
  identity: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 8 },
  identityText: { flex: 1, gap: 2 },
  name: { ...TYPE.title },
  address: { ...TYPE.footnote }
})
