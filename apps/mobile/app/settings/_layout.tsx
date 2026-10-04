/**
 * Nested stack for the Settings folder (docs/10 "Settings and agent
 * details"): the root stack (`app/_layout.tsx`) presents this whole folder
 * as one modal sheet. Every screen here draws its own `Page` header, so no
 * native header is shown, and Gateway/Appearance push inside the modal with
 * the normal card animation instead of opening as separate modals.
 */

import { Stack } from 'expo-router'

export default function SettingsLayout() {
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="index" />
      <Stack.Screen name="gateway" />
      <Stack.Screen name="appearance" />
      <Stack.Screen name="design-system" />
    </Stack>
  )
}
