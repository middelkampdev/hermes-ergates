/**
 * Update ready: asks once before the app replaces the Ergates plugin on the
 * user's Hermes server with the version this build carries, does it with one
 * tap and shows the four steps while it runs. Reached from the update notices.
 * A screen that opens while an update is running rejoins it.
 *
 * A thin renderer: the text, the buttons and the rules for them come from
 * `updateView` in `src/features/server/update-view.ts`.
 */

import { useQueryClient } from '@tanstack/react-query'
import { Redirect, useRouter } from 'expo-router'
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native'

import {
  joinTarget,
  offerOf,
  PENDING_UPDATE_RUN,
  runningKind,
  runUpdate,
  serverCheckKey,
  targetOf,
  updateScreenView,
  useServerCheck,
  type UpdateAction,
  type UpdateRunState,
  type UpdateTarget
} from '@/features/server'
import { usePrimaryConnection } from '@/features/settings'
import { useGateway } from '@/gateway/registry'
import { buildRecord } from '@/lib/build-info'
import { useDeviceStore, type Connection } from '@/state/device-store'
import { useTheme } from '@/theme/provider'
import { LEADING, SPACE, TYPE } from '@/theme/tokens'
import { AutoUpdateSwitch } from '@/ui/AutoUpdateSwitch'
import { Button } from '@/ui/Button'
import { Page } from '@/ui/Page'
import { StepList } from '@/ui/StepList'

const TITLE = 'Update ready'

export default function UpdateReadyScreen() {
  const connection = usePrimaryConnection()
  if (!connection) {
    return <Redirect href="/connect" />
  }
  return <UpdateReady connection={connection} />
}

function UpdateReady({ connection }: { connection: Connection }) {
  const theme = useTheme()
  const router = useRouter()
  const queryClient = useQueryClient()
  const gateway = useGateway(connection)
  const updateConnection = useDeviceStore(s => s.updateConnection)
  const build = useMemo(() => buildRecord(), [])
  const check = useServerCheck(connection, build)
  // An update that is already going (the user left this screen and came back) is joined, not offered again. A setup going is not this screen's to join.
  const rejoin = useRef(runningKind(connection.id) === 'update' && joinTarget(build, connection) !== null)
  const [run, setRun] = useState<UpdateRunState | null>(() => (rejoin.current ? PENDING_UPDATE_RUN : null))
  // What the last run was started with, so Try again repeats it even when the check no longer offers it.
  const started = useRef<UpdateTarget | null>(null)
  // The run keeps reporting after this screen is gone; only a mounted screen draws it.
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const openFinish = useCallback(() => router.push('/server/finish'), [router])

  const start = useCallback(
    async (target: UpdateTarget) => {
      if (build === null) {
        return
      }
      started.current = target
      setRun(PENDING_UPDATE_RUN)
      const outcome = await runUpdate({ port: gateway, build, connectionId: connection.id, ...target }, (step, status) => {
        if (mounted.current) {
          setRun(current => (current ? { ...current, steps: { ...current.steps, [step]: status } } : current))
        }
      })
      if (outcome.kind !== 'sign_in') {
        // Home and the other screens read the same check: make them see what the run left, and Finish open on it, not on the check from before the run.
        await queryClient.invalidateQueries({ queryKey: serverCheckKey(connection.id) })
      }
      if (!mounted.current) {
        return
      }
      setRun(current => ({ steps: current?.steps ?? PENDING_UPDATE_RUN.steps, outcome }))
      if (outcome.kind === 'restart' || outcome.kind === 'manual') {
        openFinish()
      }
    },
    [build, gateway, connection.id, queryClient, openFinish]
  )

  useEffect(() => {
    if (rejoin.current) {
      rejoin.current = false
      const target = joinTarget(build, connection)
      if (target !== null) {
        void start(target)
      }
    }
  }, [start, build, connection])

  const act = (action: UpdateAction | 'later' | 'not_now') => {
    const offer = offerOf(check.data)
    switch (action) {
      case 'update':
        if (offer !== null) {
          void start(targetOf(offer))
        }
        return
      case 'retry':
        if (started.current !== null) {
          void start(started.current)
        }
        return
      case 'check_again':
        void check.refetch()
        return
      case 'finish':
        openFinish()
        return
      case 'sign_in':
        router.push({ pathname: '/sign-in', params: { connection: connection.id } })
        return
      case 'later':
        if (offer !== null) {
          updateConnection(connection.id, { askedUpdateFor: offer.commit })
        }
        router.dismissTo('/')
        return
      case 'done':
      case 'not_now':
        // Home is under this screen when it was pushed from there, and not when a notice replaced into it.
        router.dismissTo('/')
        return
    }
  }

  const goBack = () => (router.canGoBack() ? router.back() : router.replace('/'))

  const view = updateScreenView({ data: check.data, error: check.error }, connection, run)
  if (view === null) {
    return (
      <Page title={TITLE} onBack={goBack}>
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
            {primary ? <Button label={primary.label} onPress={() => act(primary.action)} loading={primary.action === 'check_again' && check.isFetching} /> : null}
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
        {view.autoUpdateSwitch ? <AutoUpdateSwitch connection={connection} /> : null}
      </View>
      {view.steps ? <StepList steps={view.steps} /> : null}
    </Page>
  )
}

const styles = StyleSheet.create({
  text: { gap: SPACE.medium },
  paragraph: { ...TYPE.body, lineHeight: LEADING.body },
  detail: { ...TYPE.callout, lineHeight: LEADING.callout },
  actions: { gap: SPACE.small },
  spinner: { marginVertical: SPACE.huge }
})
