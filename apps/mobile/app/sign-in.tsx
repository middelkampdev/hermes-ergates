/**
 * Sign in again to a saved connection, in place: after an expired session, or
 * on a rooted or jailbroken phone, which keeps no sign-in across restarts.
 * Unlike Sign out, the connection keeps its drafts, outbox, agent setups and
 * organization. Reached as `/sign-in?connection=<id>`; without a known id it
 * signs in the primary connection.
 */

import { useQueryClient } from '@tanstack/react-query'
import { Redirect, useLocalSearchParams, useRouter } from 'expo-router'
import React, { useEffect, useState } from 'react'
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, View } from 'react-native'

import { BLANK_CREDENTIALS, connectionToSignIn, credentialsFrom, credentialsReady, firstProvider, signInAgain, usePrimaryConnection, type CredentialValues } from '@/features/settings'
import { useGateway, useGatewayRegistry } from '@/gateway/registry'
import { useDeviceStore, type Connection } from '@/state/device-store'
import { currentDeviceTrust, rootedReasonLine } from '@/state/device-trust'
import { useTheme } from '@/theme/provider'
import { LEADING, SPACE, TYPE } from '@/theme/tokens'
import { Button } from '@/ui/Button'
import { CredentialFields } from '@/ui/CredentialFields'
import { Screen } from '@/ui/Screen'
import { useBottomInset } from '@/ui/use-bottom-inset'

export default function SignInScreen() {
  const { connection: connectionId } = useLocalSearchParams<{ connection?: string }>()
  const connection = useDeviceStore(s => connectionToSignIn(s.connections, connectionId))
  if (!connection) {
    return <Redirect href="/connect" />
  }
  return <SignIn connection={connection} />
}

function SignIn({ connection }: { connection: Connection }) {
  const theme = useTheme()
  const router = useRouter()
  const registry = useGatewayRegistry()
  const gateway = useGateway(connection)
  const queryClient = useQueryClient()
  const bottomInset = useBottomInset(SPACE.giant)
  const mode = connection.authMode
  const isPrimary = usePrimaryConnection()?.id === connection.id
  const [credentials, setCredentials] = useState<CredentialValues>(BLANK_CREDENTIALS)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Preselect the gateway's first provider, as Connect does. Unreachable is fine
  // here: signing in reports it.
  useEffect(() => {
    if (mode !== 'password') {
      return
    }
    let alive = true
    gateway
      .status()
      .then(status => {
        const provider = firstProvider(status)
        if (alive && provider) {
          setCredentials(c => ({ ...c, provider }))
        }
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [gateway, mode])

  const signIn = async () => {
    setBusy(true)
    setError(null)
    try {
      await signInAgain(registry, connection, credentialsFrom(mode, credentials))
      // Everything read while signed out failed; read it again with the new sign-in.
      void queryClient.invalidateQueries()
      // A chat below this screen keeps the session that failed, so Home starts a fresh stack.
      if (router.canDismiss()) {
        router.dismissAll()
      }
      router.replace('/')
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Screen>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.flex}>
        <ScrollView contentContainerStyle={[styles.content, { paddingBottom: bottomInset }]} keyboardShouldPersistTaps="handled">
          <View style={styles.header}>
            <Text style={[styles.title, { color: theme.colors.foreground }]}>Sign in again</Text>
            <Text style={[styles.subtitle, { color: theme.colors.mutedForeground }]}>
              {connection.label}
              {'\n'}
              {connection.baseUrl}
            </Text>
            {currentDeviceTrust() === 'rooted' ? <Text style={[styles.hint, { color: theme.colors.mutedForeground }]}>{rootedReasonLine(Platform.OS)}</Text> : null}
          </View>
          <CredentialFields mode={mode} values={credentials} onChange={patch => setCredentials(c => ({ ...c, ...patch }))} />
          <Button label={busy ? 'Signing in…' : 'Sign in'} onPress={signIn} loading={busy} disabled={!credentialsReady(mode, credentials) || busy} />
          {error ? (
            <Text style={[styles.error, { color: theme.colors.destructive }]} accessibilityRole="alert">
              {error}
            </Text>
          ) : null}
          {/* Settings acts on the primary connection only. Home replaces itself with this screen for the primary
              one, so there Settings is the only way to Sign out or the gateway details; any other connection
              arrives here pushed from its chat, where Back still works. */}
          {isPrimary ? <Button label="Settings" variant="secondary" onPress={() => router.push('/settings')} disabled={busy} /> : null}
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  )
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: { gap: SPACE.extraSmall, paddingTop: SPACE.huge },
  header: { gap: SPACE.extraSmall, marginBottom: SPACE.large },
  title: { ...TYPE.largeTitle },
  subtitle: { ...TYPE.body, lineHeight: LEADING.body },
  hint: { ...TYPE.callout, lineHeight: LEADING.callout },
  error: { ...TYPE.callout, lineHeight: LEADING.callout, marginTop: SPACE.extraSmall }
})
