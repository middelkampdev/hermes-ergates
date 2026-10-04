/**
 * Move to Section (docs/10 "Bot actions"): moves one or more agents to No
 * section or to a section, or into a new section named here, then goes back.
 * Opened from the long-press menu and from the Home Edit mode bottom bar.
 */

import { useLocalSearchParams, useRouter } from 'expo-router'
import React, { useMemo, useRef, useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'

import { canCreateSection, parseProfiles, sectionChoices, useHome, useOrganizer } from '@/features/agents'
import { usePrimaryConnection } from '@/features/settings'
import { useGateway } from '@/gateway/registry'
import type { Connection } from '@/state/device-store'
import { useTheme } from '@/theme/provider'
import { ICON, LEADING, TYPE } from '@/theme/tokens'
import { Button } from '@/ui/Button'
import { Field } from '@/ui/Field'
import { Group } from '@/ui/Group'
import { Icon } from '@/ui/icons'
import { ListRow } from '@/ui/ListRow'
import { Page } from '@/ui/Page'

export default function MoveToSectionScreen() {
  const router = useRouter()
  const params = useLocalSearchParams<{ profiles?: string }>()
  const connection = usePrimaryConnection()
  const profiles = useMemo(() => parseProfiles(params.profiles), [params.profiles])
  if (!connection) {
    return null
  }
  return <MoveToSection connection={connection} profiles={profiles} onDone={() => router.back()} />
}

function MoveToSection({ connection, profiles, onDone }: { connection: Connection; profiles: string[]; onDone: () => void }) {
  const theme = useTheme()
  const home = useHome(useGateway(connection), connection.id)
  const organizer = useOrganizer(connection.id, home.rows)
  const [name, setName] = useState('')
  // A ref, not state: state only takes effect on the next render, so a second
  // tap landing in the same frame (before the pop transition unmounts this
  // screen) would still read `false` and run again — minting a second, empty,
  // orphaned section, or moving and popping twice. The ref is set synchronously
  // before anything else runs, so every entry point (Create, every row) shares
  // one guard and this page calls `onDone()` at most once.
  const done = useRef(false)

  const runOnce = (fn: () => void) => {
    if (done.current) {
      return
    }
    done.current = true
    fn()
  }

  const moveTo = (sectionId: string | null) =>
    runOnce(() => {
      organizer.moveToSection(profiles, sectionId)
      onDone()
    })

  const create = () =>
    runOnce(() => {
      organizer.createSectionWith(profiles, name)
      onDone()
    })

  return (
    <Page title="Move to Section" onBack={() => runOnce(onDone)}>
      <Text style={[styles.hint, { color: theme.colors.mutedForeground }]}>Hermes Desktop shows the same section for each agent. A pinned agent stays pinned.</Text>
      <Group>
        {sectionChoices(home.organization, profiles).map(choice => (
          <ListRow
            key={choice.id ?? 'none'}
            title={choice.name}
            icon={choice.id === null ? 'inbox' : 'folder'}
            selected={choice.checked}
            right={choice.checked ? <Icon name="check" size={ICON.row} color={theme.colors.primary} /> : <View style={styles.noCheck} />}
            onPress={() => moveTo(choice.id)}
          />
        ))}
      </Group>
      <View>
        <Field label="New section name" value={name} onChangeText={setName} placeholder="Prive" />
        <Button label="Create section" onPress={create} disabled={!canCreateSection(name)} />
      </View>
    </Page>
  )
}

const styles = StyleSheet.create({
  hint: { ...TYPE.callout, lineHeight: LEADING.callout },
  noCheck: { width: ICON.row }
})
