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
import { Alert, KeyboardAvoidingView, Linking, Platform, ScrollView, StyleSheet, Text, View } from 'react-native'

import { afterSignIn, SIGNED_OUT_HINT } from '@/features/server'
import {
  BLANK_CREDENTIALS,
  connectionToSignIn,
  credentialsFrom,
  credentialsReady,
  firstProvider,
  GRADE_GUIDE,
  guideLabel,
  signInAgain,
  signInFailure,
  signInModeFrom,
  usePrimaryConnection,
  type CredentialValues,
  type SignInFailure
} from '@/features/settings'
import { useGateway, useGatewayRegistry } from '@/gateway/registry'
import type { BackendStatus } from '@/gateway/types'
import { buildRecord } from '@/lib/build-info'
import { useDeviceStore, type Connection } from '@/state/device-store'
import { currentDeviceTrust, rootedReasonLine } from '@/state/device-trust'
import { useTheme } from '@/theme/provider'
import { LEADING, SPACE, TYPE } from '@/theme/tokens'
import { Button } from '@/ui/Button'
import { CredentialFields } from '@/ui/CredentialFields'
import { GuideLink } from '@/ui/GuideLink'
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
  const isPrimary = usePrimaryConnection()?.id === connection.id
  const [status, setStatus] = useState<BackendStatus | null>(null)
  // The fields follow how the server signs in now: it may have moved between a token and a password since the
  // connection was saved. Until it answers, or when it cannot be asked, the saved mode picks them.
  const mode = signInModeFrom(status, connection.authMode)
  const [credentials, setCredentials] = useState<CredentialValues>(BLANK_CREDENTIALS)
  const [busy, setBusy] = useState(false)
  // The failure to show, with the grade when the app refused the server or the password, so the guide can be offered.
  const [failure, setFailure] = useState<SignInFailure | null>(null)

  // Read a fresh status and preselect the gateway's first provider, as Connect does. Unreachable is fine here:
  // signing in reports it. The transport guard sends nothing to a public address over plain http.
  useEffect(() => {
    let alive = true
    gateway
      .status()
      .then(answer => {
        if (!alive) {
          return
        }
        setStatus(answer)
        const provider = firstProvider(answer)
        if (provider) {
          setCredentials(c => ({ ...c, provider }))
        }
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [gateway])

  const signIn = async () => {
    setBusy(true)
    setFailure(null)
    try {
      await signInAgain(registry, connection, credentialsFrom(mode, credentials))
      // Everything read while signed out failed; read it again with the new sign-in.
      void queryClient.invalidateQueries()
      // The setup screens act on the primary connection, so another connection goes straight Home.
      const route = isPrimary ? await afterSignIn(gateway, buildRecord(), connection) : '/'
      // A chat below this screen keeps the session that failed, so Home starts a fresh stack.
      if (router.canDismiss()) {
        router.dismissAll()
      }
      router.replace(route)
    } catch (err) {
      setFailure(signInFailure(err))
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
            <Text style={[styles.hint, { color: theme.colors.mutedForeground }]}>{SIGNED_OUT_HINT.text}</Text>
            <View style={styles.link}>
              <Button
                label={SIGNED_OUT_HINT.label}
                variant="ghost"
                compact
                onPress={() => {
                  Linking.openURL(SIGNED_OUT_HINT.url).catch(() => Alert.alert('Could not open the guide', SIGNED_OUT_HINT.url))
                }}
              />
            </View>
          </View>
          <CredentialFields mode={mode} values={credentials} onChange={patch => setCredentials(c => ({ ...c, ...patch }))} />
          <Button label={busy ? 'Signing in…' : 'Sign in'} onPress={signIn} loading={busy} disabled={!credentialsReady(mode, credentials) || busy} />
          {failure ? (
            <Text style={[styles.error, { color: theme.colors.destructive }]} accessibilityRole="alert">
              {failure.message}
            </Text>
          ) : null}
          {failure?.grade ? <GuideLink label={guideLabel(failure.grade)} url={GRADE_GUIDE[failure.grade.kind]} /> : null}
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
  link: { alignItems: 'flex-start' },
  error: { ...TYPE.callout, lineHeight: LEADING.callout, marginTop: SPACE.extraSmall }
})
