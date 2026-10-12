/**
 * Set up your server: asks once before the app puts its plugin on the user's
 * Hermes server, does it with one tap and shows the four steps while it runs.
 * Reached after Connect and Sign in again when the check finds the plugin
 * missing or turned off. A screen that opens while a run is going rejoins it.
 *
 * A thin renderer: the text, the buttons and the rules for them come from
 * `setupView` in `src/features/server/setup-view.ts`.
 */

import { useQueryClient } from '@tanstack/react-query'
import { Redirect, useRouter } from 'expo-router'
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native'

import {
  finishParams,
  isSetupRunning,
  routeAfterCheck,
  runSetup,
  SETUP_TITLE,
  serverCheckKey,
  setupView,
  signedOutView,
  stepStatusWord,
  useServerCheck,
  type BuildRecord,
  type FinishParams,
  type SetupAction,
  type SetupRunState,
  type SetupStep,
  type SetupView,
  type StepStatus
} from '@/features/server'
import { usePrimaryConnection } from '@/features/settings'
import { isGatewayError } from '@/gateway/errors'
import { useGateway } from '@/gateway/registry'
import { buildRecord } from '@/lib/build-info'
import type { Connection } from '@/state/device-store'
import { useTheme } from '@/theme/provider'
import { LEADING, SPACE, TYPE } from '@/theme/tokens'
import { Button } from '@/ui/Button'
import { Group } from '@/ui/Group'
import type { IconName } from '@/ui/icons'
import { ListRow } from '@/ui/ListRow'
import { Page } from '@/ui/Page'

const PENDING_STEPS: Record<SetupStep, StepStatus> = { install: 'pending', enable: 'pending', start: 'pending', setup: 'pending' }

const STEP_ICON: Record<StepStatus, IconName> = {
  pending: 'circle',
  active: 'loader',
  done: 'check-circle',
  skipped: 'check-circle',
  failed: 'x-circle'
}

export default function ServerSetupScreen() {
  const connection = usePrimaryConnection()
  if (!connection) {
    return <Redirect href="/connect" />
  }
  return <ServerSetup connection={connection} />
}

function ServerSetup({ connection }: { connection: Connection }) {
  const theme = useTheme()
  const router = useRouter()
  const queryClient = useQueryClient()
  const gateway = useGateway(connection)
  const build = useMemo(() => buildRecord(), [])
  const check = useServerCheck(connection, build)
  // A run that is already going (the user left this screen and came back) is joined, not offered again.
  const rejoin = useRef(isSetupRunning(connection.id))
  const [run, setRun] = useState<SetupRunState | null>(() => (rejoin.current ? { steps: PENDING_STEPS, outcome: null } : null))
  // The run keeps reporting after this screen is gone; only a mounted screen draws it.
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const openFinish = useCallback((params: FinishParams) => router.push({ pathname: '/server/finish', params }), [router])

  const start = useCallback(async () => {
    if (build === null) {
      return
    }
    setRun({ steps: PENDING_STEPS, outcome: null })
    const outcome = await runSetup({ port: gateway, build, connectionId: connection.id }, (step, status) => {
      if (mounted.current) {
        setRun(current => (current ? { ...current, steps: { ...current.steps, [step]: status } } : current))
      }
    })
    if (outcome.kind === 'done') {
      // Home and the other screens read the same check: make them see the finished setup.
      await queryClient.invalidateQueries({ queryKey: serverCheckKey(connection.id) })
    }
    if (!mounted.current) {
      return
    }
    setRun(current => ({ steps: current?.steps ?? PENDING_STEPS, outcome }))
    const params = finishParams(outcome)
    if (params) {
      openFinish(params)
    }
  }, [build, gateway, connection.id, queryClient, openFinish])

  useEffect(() => {
    if (rejoin.current) {
      rejoin.current = false
      void start()
    }
  }, [start])

  const act = (action: SetupAction | 'not_now') => {
    switch (action) {
      case 'run':
      case 'turn_on':
      case 'retry':
        void start()
        return
      case 'finish':
        openFinish(finishParams(run?.outcome ?? null) ?? {})
        return
      case 'sign_in':
        router.push({ pathname: '/sign-in', params: { connection: connection.id } })
        return
      case 'done':
      case 'not_now':
        router.replace('/')
        return
    }
  }

  const goBack = () => (router.canGoBack() ? router.back() : router.replace('/'))

  if (run === null && check.data && routeAfterCheck(check.data) === '/server/finish') {
    return <Redirect href="/server/finish" />
  }

  const view = viewOf(check, build, run)
  if (view === null) {
    return (
      <Page title={SETUP_TITLE} onBack={goBack}>
        <ActivityIndicator style={styles.spinner} />
      </Page>
    )
  }

  const { primary, secondary } = view
  return (
    <Page
      title={view.title}
      onBack={goBack}
      footer={
        primary || secondary ? (
          <View style={styles.actions}>
            {primary ? <Button label={primary.label} onPress={() => act(primary.action)} /> : null}
            {secondary ? <Button label={secondary.label} variant="secondary" onPress={() => act(secondary.action)} /> : null}
          </View>
        ) : undefined
      }
    >
      <View style={styles.text}>
        {view.body.map(paragraph => (
          <Text key={paragraph} style={[styles.paragraph, { color: theme.colors.foreground }]}>
            {paragraph}
          </Text>
        ))}
        {view.source ? <Text style={[styles.detail, { color: theme.colors.mutedForeground }]}>{view.source}</Text> : null}
        {view.note ? <Text style={[styles.detail, { color: theme.colors.mutedForeground }]}>{view.note}</Text> : null}
      </View>
      {view.steps ? (
        <Group>
          {view.steps.map(step => (
            <ListRow
              key={step.label}
              title={step.label}
              icon={STEP_ICON[step.status]}
              destructive={step.status === 'failed'}
              right={step.status === 'active' ? <ActivityIndicator accessibilityLabel={stepStatusWord('active')} /> : undefined}
              accessibilityLabel={`${step.label}, ${stepStatusWord(step.status)}`}
            />
          ))}
        </Group>
      ) : null}
    </Page>
  )
}

/** The view to draw, or null while the first check is still on its way. */
function viewOf(check: ReturnType<typeof useServerCheck>, build: BuildRecord | null, run: SetupRunState | null): SetupView | null {
  if (run !== null) {
    return setupView(check.data ?? { kind: 'unknown' }, build, run)
  }
  if (check.data) {
    return setupView(check.data, build, null)
  }
  if (check.isError) {
    return isGatewayError(check.error) && check.error.kind === 'unauthorized' ? signedOutView() : setupView({ kind: 'unknown' }, build, null)
  }
  return null
}

const styles = StyleSheet.create({
  text: { gap: SPACE.medium },
  paragraph: { ...TYPE.body, lineHeight: LEADING.body },
  detail: { ...TYPE.callout, lineHeight: LEADING.callout },
  actions: { gap: SPACE.small },
  spinner: { marginVertical: SPACE.huge }
})
