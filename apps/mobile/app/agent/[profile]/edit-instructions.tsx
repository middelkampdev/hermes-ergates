/**
 * Instructions: a full-screen editor for `SOUL.md` (docs/10 "Edit Bot on
 * mobile"). Pushed from Edit Bot and shares its draft through
 * `EditBotProvider`; text is kept exactly as typed.
 */

import { useRouter } from 'expo-router'
import React from 'react'
import { ActivityIndicator, StyleSheet, Text, TextInput, useWindowDimensions } from 'react-native'

import { useEditBotContext } from '@/features/agents'
import { softFill } from '@/theme/fill'
import { useTheme } from '@/theme/provider'
import { LEADING, RADIUS, TYPE } from '@/theme/tokens'
import { Page } from '@/ui/Page'
import { useSurface } from '@/ui/surface-context'

export default function EditInstructionsScreen() {
  const theme = useTheme()
  const router = useRouter()
  const { draft, update } = useEditBotContext()
  const surface = useSurface()
  // Inside a scrolling page the editor cannot fill the screen, so it starts at half its height and grows with the text.
  const { height } = useWindowDimensions()

  return (
    <Page title="Instructions" onBack={() => router.back()}>
      {draft ? (
        <>
          <TextInput
            multiline
            value={draft.soul}
            onChangeText={soul => update({ soul })}
            placeholder="Write the bot's SOUL.md instructions…"
            placeholderTextColor={theme.colors.mutedForeground}
            textAlignVertical="top"
            accessibilityLabel="Instructions"
            selectionColor={theme.colors.primary}
            style={[styles.editor, { minHeight: height / 2, color: theme.colors.foreground, backgroundColor: softFill(theme.colors, surface) }]}
          />
          <Text style={[styles.note, { color: theme.colors.mutedForeground }]}>
            The Bot Chat messaging protocol is added by Hermes at run time; do not paste it here.
          </Text>
        </>
      ) : (
        <ActivityIndicator style={styles.loading} color={theme.colors.foreground} />
      )}
    </Page>
  )
}

const styles = StyleSheet.create({
  loading: { marginTop: 40 },
  editor: { borderRadius: RADIUS.field, paddingHorizontal: 14, paddingVertical: 13, ...TYPE.body, lineHeight: LEADING.body },
  note: { ...TYPE.footnote, lineHeight: LEADING.footnote }
})
