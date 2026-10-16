import { useRouter } from 'expo-router'
import React, { useEffect, useState } from 'react'
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, View } from 'react-native'

import { afterSignIn } from '@/features/server'
import {
  BLANK_CREDENTIALS,
  canConnect,
  connectGateway,
  connectionGrade,
  credentialsFrom,
  firstProvider,
  GRADE_GUIDE,
  gradeLine,
  guideLabel,
  probeGateway,
  signInFailure,
  type CredentialValues,
  type SignInFailure
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
  // The failure to show, with the grade when the app refused the address or the password, so the guide can be offered.
  const [failure, setFailure] = useState<SignInFailure | null>(null)
  const mode = status?.auth_required ? 'password' : 'token'
  const grade = status ? connectionGrade(baseUrl, status) : null

  const check = async () => {
    setBusy('check')
    setFailure(null)
    try {
      const s = await probeGateway(registry, baseUrl)
      setStatus(s)
      const provider = firstProvider(s)
      if (provider) {
        setCredentials(c => ({ ...c, provider }))
      }
    } catch (err) {
      setStatus(null)
      setFailure(signInFailure(err))
    } finally {
      setBusy(null)
    }
  }

  const connect = async () => {
    if (!status) {
      return
    }
    setBusy('connect')
    setFailure(null)
    try {
      const connection = await connectGateway(registry, { label, baseUrl, ...credentialsFrom(mode, credentials) })
      router.replace(await afterSignIn(registry.get(connection), buildRecord(), connection))
    } catch (err) {
      setFailure(signInFailure(err))
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
          setFailure(signInFailure(err))
        } finally {
          setBusy(null)
        }
      })()
    }
  }, [registry, router])

  return (
    <Screen>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.flex}>
        <ScrollView contentContainerStyle={[styles.content, { paddingBottom: bottomInset }]} keyboardShouldPersistTaps="handled">
          <Text style={[styles.title, { color: theme.colors.foreground }]}>Connect a gateway</Text>
          <Text style={[styles.subtitle, { color: theme.colors.mutedForeground }]}>Your assistants run on your own Hermes server. Enter its address to begin.</Text>
          <Field label="Name" value={label} onChangeText={setLabel} placeholder="Home server" />
          <Field label="Gateway URL" value={baseUrl} onChangeText={t => { setBaseUrl(t); setStatus(null); setFailure(null) }} placeholder="http://100.x.y.z:9119" keyboardType="url" accessibilityLabel="Gateway URL" />
          <Button label={busy === 'check' ? 'Checking…' : status ? 'Checked' : 'Check'} onPress={check} variant="secondary" loading={busy === 'check'} disabled={busy !== null} />
          {status && grade ? (
            <View style={styles.section}>
              <Text style={[styles.hint, { color: theme.colors.mutedForeground }]}>{gradeLine(grade, status.version)}</Text>
              <GuideLink label={guideLabel(grade)} url={GRADE_GUIDE[grade.kind]} />
              {grade.kind !== 'unsafe' ? <CredentialFields mode={mode} values={credentials} onChange={patch => setCredentials(c => ({ ...c, ...patch }))} /> : null}
              <Button label={busy === 'connect' ? 'Connecting…' : 'Connect'} onPress={connect} loading={busy === 'connect'} disabled={!canConnect(grade, mode, credentials) || busy !== null} />
            </View>
          ) : null}
          {failure ? (
            <Text style={[styles.error, { color: theme.colors.destructive }]} accessibilityRole="alert">
              {failure.message}
            </Text>
          ) : null}
          {/* A refusal before the server answered has no grade line above it, so the guide goes under the refusal. */}
          {failure?.grade && !status ? <GuideLink label={guideLabel(failure.grade)} url={GRADE_GUIDE[failure.grade.kind]} /> : null}
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
