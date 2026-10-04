/**
 * The Section page (docs/10 "Home sections and pinned members"): renames a
 * section, or deletes it after a confirmation; its agents move to the end of
 * No section and pins stay. Opened by a long-press on a section header on
 * Home, in and out of Edit mode, or by the header's Edit section action.
 */

import { useLocalSearchParams, useRouter } from 'expo-router'
import React, { useRef, useState } from 'react'
import { Alert, StyleSheet, Text, View } from 'react-native'

import { canSaveSectionName, deleteSectionPrompt, shownSectionName, useHome, useOrganizer } from '@/features/agents'
import { usePrimaryConnection } from '@/features/settings'
import { useGateway } from '@/gateway/registry'
import { useDeviceStore, type Connection } from '@/state/device-store'
import type { Section } from '@/state/organization'
import { useTheme } from '@/theme/provider'
import { LEADING, TYPE } from '@/theme/tokens'
import { Button } from '@/ui/Button'
import { Field } from '@/ui/Field'
import { Page } from '@/ui/Page'

export default function SectionScreen() {
  const router = useRouter()
  const theme = useTheme()
  const { id } = useLocalSearchParams<{ id?: string }>()
  const connection = usePrimaryConnection()
  const section = useDeviceStore(s => (connection ? s.organization[connection.id]?.sections.find(x => x.id === id) : undefined))
  // The section as the page opened it: after Delete it leaves the store while the page slides away.
  const [opened] = useState(section)
  const onDone = () => router.back()
  if (!connection) {
    return null
  }
  if (!opened) {
    return (
      <Page title="Section" onBack={onDone}>
        <Text style={[styles.hint, { color: theme.colors.mutedForeground }]}>This section no longer exists.</Text>
      </Page>
    )
  }
  return <SectionEditor connection={connection} section={opened} onDone={onDone} />
}

function SectionEditor({ connection, section, onDone }: { connection: Connection; section: Section; onDone: () => void }) {
  const theme = useTheme()
  const home = useHome(useGateway(connection), connection.id)
  const organizer = useOrganizer(connection.id, home.rows)
  // The name Home already shows for this section, which can differ from the
  // stored name right after a Desktop rename (`shownSectionName`).
  const shownName = shownSectionName(home.organization.sections, section.id, section.name)
  const [name, setName] = useState(shownName)
  // Save and Delete run organizing actions, which need the roster to merge
  // pins and sections against; with none loaded yet they would wipe them.
  const waitingForRoster = home.rows.length === 0
  // A ref, not state: a second tap landing before the pop transition unmounts
  // this screen would still read stale state and run again, renaming or
  // deleting twice (as in move-to-section.tsx).
  const done = useRef(false)

  const runOnce = (fn: () => void) => {
    if (done.current) {
      return
    }
    done.current = true
    fn()
  }

  const save = () =>
    runOnce(() => {
      organizer.renameSection(section.id, name.trim())
      onDone()
    })

  const confirmDelete = () => {
    const prompt = deleteSectionPrompt(shownName)
    Alert.alert(prompt.title, prompt.message, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: prompt.confirm,
        style: 'destructive',
        onPress: () =>
          runOnce(() => {
            organizer.deleteSection(section.id)
            onDone()
          })
      }
    ])
  }

  return (
    <Page title="Section" onBack={() => runOnce(onDone)}>
      <View>
        <Field label="Name" value={name} onChangeText={setName} placeholder="Prive" />
        <Button label="Save" onPress={save} disabled={waitingForRoster || !canSaveSectionName(name, shownName)} />
      </View>
      <Button label="Delete section" variant="destructive" onPress={confirmDelete} disabled={waitingForRoster} />
      {waitingForRoster ? <Text style={[styles.hint, { color: theme.colors.mutedForeground }]}>Waiting for the agent list.</Text> : null}
    </Page>
  )
}

const styles = StyleSheet.create({
  hint: { ...TYPE.callout, lineHeight: LEADING.callout }
})
