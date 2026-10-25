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
  askedOnOpen,
  joinUpdate,
  offerOf,
  PENDING_UPDATE_RUN,
  retryTarget,
  runningKind,
  runUpdate,
  serverCheckKey,
  targetOf,
  updateScreenView,
  useServerCheck,
  type UpdateAction,
  type UpdateOutcome,
  type StepStatus,
  type UpdateRunState,
  type UpdateStep,
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
  // Opening the screen counts as asked, also for a user who leaves with Back.
  const asked = askedOnOpen(offerOf(check.data), connection)
  useEffect(() => {
    if (asked !== null) {
      updateConnection(connection.id, { askedUpdateFor: asked })
    }
  }, [asked, connection.id, updateConnection])
  // An update that is already going (the user left this screen and came back) is joined, not offered again. A setup going is not this screen's to join.
  const rejoin = useRef(runningKind(connection.id) === 'update')
  const [run, setRun] = useState<UpdateRunState | null>(() => (rejoin.current ? PENDING_UPDATE_RUN : null))
  // The run keeps reporting after this screen is gone; only a mounted screen draws it.
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const openFinish = useCallback(() => router.push('/server/finish'), [router])

  const report = useCallback((step: UpdateStep, status: StepStatus) => {
    if (mounted.current) {
      setRun(current => (current ? { ...current, steps: { ...current.steps, [step]: status } } : current))
    }
  }, [])

  // What a run left on the server is for every screen to see; Finish opens on it, not on the check from before the run.
  const settle = useCallback(
    async (outcome: UpdateOutcome) => {
      // Not after a sign-in end: the session is gone, so a check would only answer 401 again. This screen
      // shows the sign-in view of the run, and Home asks the server again when it comes back into view.
      if (outcome.kind !== 'sign_in') {
        await queryClient.invalidateQueries({ queryKey: serverCheckKey(connection.id) })
      }
      if (!mounted.current) {
        return
      }
      if (outcome.kind === 'stale') {
        // The run changed nothing: the screen shows the offer of the check it just asked again, or that there is none.
        setRun(null)
        return
      }
      setRun(current => ({ steps: current?.steps ?? PENDING_UPDATE_RUN.steps, outcome }))
      if (outcome.kind === 'restart' || outcome.kind === 'manual') {
        openFinish()
      }
    },
    [queryClient, connection.id, openFinish]
  )

  const start = useCallback(
    async (target: UpdateTarget) => {
      if (build === null) {
        return
      }
      setRun(PENDING_UPDATE_RUN)
      await settle(await runUpdate({ port: gateway, build, connectionId: connection.id, ...target }, report))
    },
    [build, gateway, connection.id, report, settle]
  )

  useEffect(() => {
    if (!rejoin.current) {
      return
    }
    rejoin.current = false
    const joining = joinUpdate(connection.id, false, report)
    if (joining === null) {
      // The run ended before this screen got to it: show what the server says now, and start nothing.
      setRun(null)
      void queryClient.invalidateQueries({ queryKey: serverCheckKey(connection.id) })
      return
    }
    void joining.then(settle)
  }, [connection.id, report, settle, queryClient])

  // Try again asks the server again and installs only what it still needs: the update may have gone through after all, or a newer plugin may be there now.
  const retry = async () => {
    const asked = await check.refetch()
    const target = retryTarget({ data: asked.data, error: asked.error })
    if (target === null) {
      if (mounted.current) {
        setRun(null)
      }
      return
    }
    await start(target)
  }

  const act = (action: UpdateAction | 'later' | 'not_now') => {
    switch (action) {
      case 'update': {
        const offer = offerOf(check.data)
        if (offer !== null) {
          void start(targetOf(offer))
        }
        return
      }
      case 'retry':
        void retry()
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
            {primary ? <Button label={primary.label} onPress={() => act(primary.action)} loading={(primary.action === 'check_again' || primary.action === 'retry') && check.isFetching} /> : null}
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
