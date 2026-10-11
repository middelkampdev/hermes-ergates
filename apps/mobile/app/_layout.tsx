import { focusManager, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Stack, useRootNavigationState, useRouter } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import React, { useEffect, useRef, useState } from 'react'
import { ActivityIndicator, Alert, AppState, Platform, View, type AppStateStatus } from 'react-native'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import { SafeAreaProvider } from 'react-native-safe-area-context'

import { GatewayRegistryProvider } from '@/gateway/registry'
import { currentDeviceTrust, expoTrustProbe, rootedNoticeCopy, startDeviceTrust } from '@/state/device-trust'
import { authSecretStore, secureSecretStore } from '@/state/persistence'
import { useDeviceStore, waitForHydration } from '@/state/device-store'
import { ThemeProvider, useTheme } from '@/theme/provider'
import { useSkinStore } from '@/theme/skin-store'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 5_000 },
    mutations: { retry: 0 }
  }
})

function useHydrated(): boolean {
  const [hydrated, setHydrated] = useState(false)
  useEffect(() => {
    let alive = true
    void useDeviceStore.persist.rehydrate()
    // The trust check needs the saved connection ids and must finish before any
    // gateway restores a sign-in, so the spinner stays up until both are done.
    waitForHydration(useDeviceStore)
      .then(() =>
        startDeviceTrust(
          authSecretStore,
          secureSecretStore,
          useDeviceStore.getState().connections.map(c => c.id),
          expoTrustProbe
        )
      )
      .then(() => {
        if (alive) {
          setHydrated(true)
        }
      })
    return () => {
      alive = false
    }
  }, [])
  return hydrated
}

/**
 * Development smoke tests only. `EXPO_PUBLIC_DEV_INITIAL_ROUTE` is inlined at
 * bundle time; `EXPO_PUBLIC_DEV_ROUTE_URL` names a local text file served over
 * HTTP whose lines are routes to push in order, so a screenshot loop can change
 * screens without rebundling. Both are compiled out of release bundles.
 */
function DevInitialRoute() {
  const router = useRouter()
  const navReady = Boolean(useRootNavigationState()?.key)
  const hasConnection = useDeviceStore(s => s.connections.length > 0)
  const firedRef = useRef(false)
  useEffect(() => {
    const route = process.env.EXPO_PUBLIC_DEV_INITIAL_ROUTE
    const routeUrl = process.env.EXPO_PUBLIC_DEV_ROUTE_URL
    if (!__DEV__ || (!route && !routeUrl) || !hasConnection || !navReady || firedRef.current) {
      return
    }
    firedRef.current = true
    let cancelled = false
    const timer = setTimeout(async () => {
      let routes = route ? [route] : []
      if (routeUrl) {
        try {
          const text = await (await fetch(routeUrl)).text()
          routes = text.split('\n').map(l => l.trim()).filter(Boolean)
        } catch {
          // No route server running: behave like a normal launch.
        }
      }
      for (const target of routes) {
        if (cancelled) {
          return
        }
        console.log('[ergates-dev] navigating', target)
        router.push(target as never)
        await new Promise(r => setTimeout(r, 900))
      }
    }, 1500)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [router, hasConnection, navReady])
  return null
}

/**
 * TanStack's `focusManager` has no `document` in React Native and so reports
 * "focused" forever, which kept the roster and routine `refetchInterval`
 * polling while the app was backgrounded. AppState is the RN equivalent.
 */
function useAppStateFocus(): void {
  useEffect(() => {
    const onChange = (status: AppStateStatus) => focusManager.setFocused(status === 'active')
    focusManager.setFocused(AppState.currentState === 'active')
    const subscription = AppState.addEventListener('change', onChange)
    return () => subscription.remove()
  }, [])
}

/** Applies a backend `skin.changed` to the theme preference once, then clears it. */
function SkinApplier() {
  const pending = useSkinStore(s => s.state.pendingApply)
  const clearPending = useSkinStore(s => s.clearPending)
  const setPrefs = useDeviceStore(s => s.setPrefs)
  useEffect(() => {
    if (pending) {
      setPrefs({ themeName: pending })
      clearPending()
    }
  }, [pending, setPrefs, clearPending])
  return null
}

/** Tells the owner once that this phone is rooted or jailbroken, and so keeps no sign-in. */
function RootedNotice() {
  const seen = useDeviceStore(s => s.prefs.rootedNoticeSeen)
  const setPrefs = useDeviceStore(s => s.setPrefs)
  const shownRef = useRef(false)
  useEffect(() => {
    if (seen || shownRef.current || currentDeviceTrust() !== 'rooted') {
      return
    }
    shownRef.current = true
    const { title, body } = rootedNoticeCopy(Platform.OS)
    Alert.alert(title, body, [{ text: 'OK', onPress: () => setPrefs({ rootedNoticeSeen: true }) }])
  }, [seen, setPrefs])
  return null
}

function ThemedStack() {
  const theme = useTheme()
  return (
    <>
      <StatusBar style={theme.dark ? 'light' : 'dark'} />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: theme.colors.background }
        }}
      >
        <Stack.Screen name="index" />
        <Stack.Screen name="connect" />
        {/* Home replaces itself with this screen when the connection has no sign-in on this phone. */}
        <Stack.Screen name="sign-in" />
        {/* A push deep link lands here first (app/+native-intent.tsx), then replaces itself with the chat. */}
        <Stack.Screen name="open" options={{ animation: 'none' }} />
        <Stack.Screen name="search" options={{ presentation: 'modal' }} />
        {/* `app/settings/_layout.tsx` owns the nested stack so Gateway and Appearance push inside this one modal. */}
        <Stack.Screen name="settings" options={{ presentation: 'modal' }} />
        <Stack.Screen name="new-agent" options={{ presentation: 'modal' }} />
        <Stack.Screen name="hidden-bots" options={{ presentation: 'modal' }} />
        <Stack.Screen name="notifications" options={{ presentation: 'modal' }} />
        {/* One entry: `app/chat/[profile]/_layout.tsx` owns the stack for the chat, Activity and the read-only transcript. */}
        <Stack.Screen name="chat/[profile]" />
      </Stack>
    </>
  )
}

export default function RootLayout() {
  const hydrated = useHydrated()
  useAppStateFocus()
  const appearance = useDeviceStore(s => s.prefs.appearance)
  const themeName = useDeviceStore(s => s.prefs.themeName)
  const backendThemes = useSkinStore(s => s.state.backend)

  if (!hydrated) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator />
      </View>
    )
  }

  // Outermost, so every gesture in the app (the Home list's drag handles) has its root.
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <QueryClientProvider client={queryClient}>
          <GatewayRegistryProvider secrets={authSecretStore}>
            <ThemeProvider appearance={appearance} themeName={themeName} backendThemes={backendThemes}>
              <SkinApplier />
              <RootedNotice />
              <DevInitialRoute />
              <ThemedStack />
            </ThemeProvider>
          </GatewayRegistryProvider>
        </QueryClientProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  )
}
