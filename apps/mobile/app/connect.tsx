import { useRouter } from 'expo-router'
import React, { useEffect, useState } from 'react'
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, View } from 'react-native'

import { afterSignIn } from '@/features/server'
import {
  BLANK_CREDENTIALS,
  connectGateway,
  connectionGrade,
  credentialsFrom,
  credentialsReady,
  firstProvider,
  GRADE_GUIDE,
  gradeLine,
  guideLabel,
  probeGateway,
  SignInRefused,
  type ConnectionGrade,
  type CredentialValues
} from '@/features/settings'
import { useGatewayRegistry } from '@/gateway/registry'
import type { BackendStatus } from '@/gateway/types'
import { buildRecord } from '@/lib/build-info'
import { useTheme } from '@/theme/provider'
import { LEADING, SPACE, TYPE } from '@/theme/tokens'
import { Button } from '@/ui/Button'
import { CredentialFields } from '@/ui/CredentialFields'
import { Field } from '@/ui/Field'
import { GuideLink } from '@/ui/GuideLink'
import { Screen } from '@/ui/Screen'
import { useBottomInset } from '@/ui/use-bottom-inset'

export default function ConnectScreen() {
  const theme = useTheme()
  const router = useRouter()
  const registry = useGatewayRegistry()
  const bottomInset = useBottomInset(SPACE.giant)
  const [label, setLabel] = useState('Local Hermes')
  const [baseUrl, setBaseUrl] = useState('http://127.0.0.1:9119')
  const [status, setStatus] = useState<BackendStatus | null>(null)
  const [credentials, setCredentials] = useState<CredentialValues>(BLANK_CREDENTIALS)
  const [busy, setBusy] = useState<'check' | 'connect' | null>(null)
  const [error, setError] = useState<string | null>(null)
  // The grade behind `error` when the app refused the address or the password, so the guide can be offered.
  const [refused, setRefused] = useState<ConnectionGrade | null>(null)
  const mode = status?.auth_required ? 'password' : 'token'
  const grade = status ? connectionGrade(baseUrl, status) : null

  const fail = (err: unknown) => {
    setError((err as Error).message)
    setRefused(err instanceof SignInRefused ? err.grade : null)
  }

  const check = async () => {
    setBusy('check')
    setError(null)
    setRefused(null)
    try {
      const s = await probeGateway(registry, baseUrl)
      setStatus(s)
      const provider = firstProvider(s)
      if (provider) {
        setCredentials(c => ({ ...c, provider }))
      }
    } catch (err) {
      setStatus(null)
      fail(err)
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
    setRefused(null)
    try {
      const connection = await connectGateway(registry, { label, baseUrl, ...credentialsFrom(mode, credentials) })
      router.replace(await afterSignIn(registry.get(connection), buildRecord(), connection))
    } catch (err) {
      fail(err)
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
      setCredentials(c => ({ ...c, token: devToken }))
      void (async () => {
        setBusy('connect')
        try {
          const s = await probeGateway(registry, devUrl)
          setStatus(s)
          if (!s.auth_required) {
            const connection = await connectGateway(registry, { label: 'Local Hermes', baseUrl: devUrl, mode: 'token', token: devToken })
            router.replace(await afterSignIn(registry.get(connection), buildRecord(), connection))
          }
        } catch (err) {
          setError((err as Error).message)
        } finally {
          setBusy(null)
        }
      })()
    }
  }, [registry, router])

  const canConnect = Boolean(status) && grade?.kind !== 'unsafe' && credentialsReady(mode, credentials)

  return (
    <Screen>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.flex}>
        <ScrollView contentContainerStyle={[styles.content, { paddingBottom: bottomInset }]} keyboardShouldPersistTaps="handled">
          <Text style={[styles.title, { color: theme.colors.foreground }]}>Connect a gateway</Text>
          <Text style={[styles.subtitle, { color: theme.colors.mutedForeground }]}>Your assistants run on your own Hermes server. Enter its address to begin.</Text>
          <Field label="Name" value={label} onChangeText={setLabel} placeholder="Home server" />
          <Field label="Gateway URL" value={baseUrl} onChangeText={t => { setBaseUrl(t); setStatus(null) }} placeholder="http://100.x.y.z:9119" keyboardType="url" accessibilityLabel="Gateway URL" />
          <Button label={busy === 'check' ? 'Checking…' : status ? 'Checked' : 'Check'} onPress={check} variant="secondary" loading={busy === 'check'} disabled={busy !== null} />
          {status && grade ? (
            <View style={styles.section}>
              <Text style={[styles.hint, { color: theme.colors.mutedForeground }]}>{gradeLine(grade, status.version)}</Text>
              <GuideLink label={guideLabel(grade)} url={GRADE_GUIDE[grade.kind]} />
              <CredentialFields mode={mode} values={credentials} onChange={patch => setCredentials(c => ({ ...c, ...patch }))} />
              <Button label={busy === 'connect' ? 'Connecting…' : 'Connect'} onPress={connect} loading={busy === 'connect'} disabled={!canConnect || busy !== null} />
            </View>
          ) : null}
          {error ? (
            <Text style={[styles.error, { color: theme.colors.destructive }]} accessibilityRole="alert">
              {error}
            </Text>
          ) : null}
          {/* A refusal before the server answered has no grade line above it, so the guide goes under the refusal. */}
          {refused && !status ? <GuideLink label={guideLabel(refused)} url={GRADE_GUIDE[refused.kind]} /> : null}
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  )
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: { gap: SPACE.extraSmall, paddingTop: SPACE.huge },
  title: { ...TYPE.largeTitle },
  subtitle: { ...TYPE.body, lineHeight: LEADING.body, marginBottom: SPACE.large },
  section: { gap: SPACE.extraSmall, marginTop: SPACE.small },
  hint: { ...TYPE.callout, lineHeight: LEADING.callout },
  error: { ...TYPE.callout, lineHeight: LEADING.callout, marginTop: SPACE.extraSmall }
})
