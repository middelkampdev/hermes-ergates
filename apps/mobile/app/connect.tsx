import { useRouter } from 'expo-router'
import React, { useEffect, useState } from 'react'
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, View } from 'react-native'

import { connectGateway, probeGateway } from '@/features/settings'
import { useGatewayRegistry } from '@/gateway/registry'
import type { BackendStatus } from '@/gateway/types'
import { useTheme } from '@/theme/provider'
import { LEADING, TYPE } from '@/theme/tokens'
import { Button } from '@/ui/Button'
import { Field } from '@/ui/Field'
import { Screen } from '@/ui/Screen'
import { useBottomInset } from '@/ui/use-bottom-inset'

const CONTENT_BOTTOM_PADDING = 40

export default function ConnectScreen() {
  const theme = useTheme()
  const router = useRouter()
  const registry = useGatewayRegistry()
  const bottomInset = useBottomInset(CONTENT_BOTTOM_PADDING)
  const [label, setLabel] = useState('Local Hermes')
  const [baseUrl, setBaseUrl] = useState('http://127.0.0.1:9119')
  const [status, setStatus] = useState<BackendStatus | null>(null)
  const [token, setToken] = useState('')
  const [provider, setProvider] = useState('basic')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState<'check' | 'connect' | null>(null)
  const [error, setError] = useState<string | null>(null)

  const check = async () => {
    setBusy('check')
    setError(null)
    try {
      const s = await probeGateway(registry, baseUrl)
      setStatus(s)
      if (s.auth_providers?.[0]) {
        setProvider(s.auth_providers[0])
      }
    } catch (err) {
      setStatus(null)
      setError((err as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const connect = async () => {
    if (!status) {
      return
    }
    setBusy('connect')
    setError(null)
    try {
      await connectGateway(
        registry,
        status.auth_required ? { label, baseUrl, mode: 'password', provider, username, password } : { label, baseUrl, mode: 'token', token }
      )
      router.replace('/')
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(null)
    }
  }

  // Development convenience only: EXPO_PUBLIC_DEV_GATEWAY_URL/_TOKEN are inlined at bundle time
  // for simulator runs against a local `hermes serve`. Never used in production bundles.
  useEffect(() => {
    if (!__DEV__) {
      return
    }
    const devUrl = process.env.EXPO_PUBLIC_DEV_GATEWAY_URL
    const devToken = process.env.EXPO_PUBLIC_DEV_GATEWAY_TOKEN
    if (!devUrl) {
      return
    }
    setBaseUrl(devUrl)
    if (devToken) {
      setToken(devToken)
      void (async () => {
        setBusy('connect')
        try {
          const s = await probeGateway(registry, devUrl)
          setStatus(s)
          if (!s.auth_required) {
            await connectGateway(registry, { label: 'Local Hermes', baseUrl: devUrl, mode: 'token', token: devToken })
            router.replace('/')
          }
        } catch (err) {
          setError((err as Error).message)
        } finally {
          setBusy(null)
        }
      })()
    }
  }, [registry, router])

  const canConnect = Boolean(status) && (status?.auth_required ? username.trim() && password : token.trim())

  return (
    <Screen>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.flex}>
        <ScrollView contentContainerStyle={[styles.content, { paddingBottom: bottomInset }]} keyboardShouldPersistTaps="handled">
          <Text style={[styles.title, { color: theme.colors.foreground }]}>Connect a gateway</Text>
          <Text style={[styles.subtitle, { color: theme.colors.mutedForeground }]}>Your assistants run on your own Hermes server. Enter its address to begin.</Text>
          <Field label="Name" value={label} onChangeText={setLabel} placeholder="Home server" />
          <Field label="Gateway URL" value={baseUrl} onChangeText={t => { setBaseUrl(t); setStatus(null) }} placeholder="http://100.x.y.z:9119" keyboardType="url" accessibilityLabel="Gateway URL" />
          <Button label={busy === 'check' ? 'Checking…' : status ? 'Checked' : 'Check'} onPress={check} variant="secondary" loading={busy === 'check'} disabled={busy !== null} />
          {status ? (
            <View style={styles.section}>
              <Text style={[styles.hint, { color: theme.colors.mutedForeground }]}>
                Hermes {status.version}. {status.auth_required ? 'This gateway asks for a username and password.' : 'This gateway runs on a private loopback address and uses a session token.'}
              </Text>
              {status.auth_required ? (
                <>
                  <Field label="Provider" value={provider} onChangeText={setProvider} />
                  <Field label="Username" value={username} onChangeText={setUsername} />
                  <Field label="Password" value={password} onChangeText={setPassword} secureTextEntry />
                </>
              ) : (
                <Field label="Session token" value={token} onChangeText={setToken} placeholder="HERMES_DASHBOARD_SESSION_TOKEN" secureTextEntry />
              )}
              <Button label={busy === 'connect' ? 'Connecting…' : 'Connect'} onPress={connect} loading={busy === 'connect'} disabled={!canConnect || busy !== null} />
            </View>
          ) : null}
          {error ? (
            <Text style={[styles.error, { color: theme.colors.destructive }]} accessibilityRole="alert">
              {error}
            </Text>
          ) : null}
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  )
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: { gap: 4, paddingTop: 24 },
  title: { ...TYPE.largeTitle },
  subtitle: { ...TYPE.body, lineHeight: LEADING.body, marginBottom: 16 },
  section: { gap: 4, marginTop: 8 },
  hint: { ...TYPE.callout, lineHeight: LEADING.callout },
  error: { ...TYPE.callout, lineHeight: LEADING.callout, marginTop: 4 }
})
