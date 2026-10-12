/**
 * Nested stack for the server setup screens: "Set up your server" and "Finish
 * on your server". Each screen draws its own `Page` header, so no native
 * header is shown. No initial route is set: a link straight to Finish must
 * not mount the setup screen underneath it, which would check the server a
 * second time and send the user back to Finish.
 */

import { Stack } from 'expo-router'

import { useTheme } from '@/theme/provider'

export default function ServerLayout() {
  const theme = useTheme()
  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: theme.colors.background } }}>
      <Stack.Screen name="index" />
      <Stack.Screen name="finish" />
    </Stack>
  )
}
