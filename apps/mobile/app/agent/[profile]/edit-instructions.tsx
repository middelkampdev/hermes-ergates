/**
 * Instructions: a full-screen editor for `SOUL.md` (docs/10 "Edit Bot on
 * mobile"). Pushed from Edit Bot and shares its draft through
 * `EditBotProvider`; text is kept exactly as typed.
 */

import { useRouter } from 'expo-router'
import React from 'react'
import { ActivityIndicator, Platform, StyleSheet, Text, TextInput, useWindowDimensions } from 'react-native'

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
  // iOS: the editor grows with its text and Page's scroll view, inset by the
  // keyboard, follows the caret above it. Android has no keyboard avoidance
  // under edge-to-edge yet, so there the editor keeps a fixed height and
  // scrolls its own text (`scrollEnabled` is iOS-only).
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
            scrollEnabled={false}
            textAlignVertical="top"
            accessibilityLabel="Instructions"
            selectionColor={theme.colors.primary}
            style={[styles.editor, { ...(Platform.OS === 'ios' ? { minHeight: height / 2 } : { height: height / 2 }), color: theme.colors.foreground, backgroundColor: softFill(theme.colors, surface) }]}
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
