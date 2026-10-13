/**
 * Finish on your server: the one page for every case where the user has to
 * act on the server. It shows what to do (a command to copy, how to restart
 * Hermes, or what to update), asks the server every few seconds, and
 * finishes the setup by itself when the plugin answers. Reached from the
 * setup screen, from the update screen and after Sign in again. After an
 * update whose new version did not start, it offers to put the previous
 * version back.
 *
 * A thin renderer: the cases, the text, the command and the buttons come from
 * `finishVariant` and `finishView` in `src/features/server/finish-view.ts`.
 */

import { useQueryClient } from '@tanstack/react-query'
import * as Clipboard from 'expo-clipboard'
import { Redirect, useIsFocused, useRouter } from 'expo-router'
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Alert, Linking, Platform, StyleSheet, Text, View } from 'react-native'

import {
  finishPendingSetup,
  finishUpdateOf,
  finishVariant,
  finishView,
  goBackTarget,
  highestSchema,
  isSignedOut,
  lastManualOutcome,
  lastUpdateOutcome,
  markPendingSetup,
  pendingCommit,
  PENDING_UPDATE_RUN,
  RESTART_HEADING,
  restartSeenAfter,
  runIsGoing,
  runUpdate,
  serverCheckKey,
  setupProblem,
  updateStillOpen,
  useServerCheck,
  type FinishAction,
  type FinishUpdate,
  type FinishVariant,
  type SetupProgress,
  type UpdateRunState
} from '@/features/server'
import { usePrimaryConnection } from '@/features/settings'
import { useGateway } from '@/gateway/registry'
import { buildRecord } from '@/lib/build-info'
import type { Connection } from '@/state/device-store'
import { useTheme } from '@/theme/provider'
import { LEADING, RADIUS, SPACE, TYPE } from '@/theme/tokens'
import { Button } from '@/ui/Button'
import { Page } from '@/ui/Page'
import { StepList } from '@/ui/StepList'

const MONOSPACE = Platform.select({ ios: 'Menlo', default: 'monospace' })

export default function FinishOnServerScreen() {
  const connection = usePrimaryConnection()
  if (!connection) {
    return <Redirect href="/connect" />
  }
  return <FinishOnServer connection={connection} />
}

function FinishOnServer({ connection }: { connection: Connection }) {
  const theme = useTheme()
  const router = useRouter()
  const queryClient = useQueryClient()
  const gateway = useGateway(connection)
  const build = useMemo(() => buildRecord(), [])
  // Why the install is by hand comes from the run that ended that way, not from the route: the text of a route is anyone's to write.
  const [manual] = useState(() => lastManualOutcome(connection.id))
  // How the update run that sent the user here ended: by hand, the plugin still works and the update is left to do on the server; with a restart, the page waits for it.
  const [ended] = useState(() => lastUpdateOutcome(connection.id))
  const focused = useIsFocused()
  // True once the plugin answered and its setup went through: nothing is left to wait for.
  const [finished, setFinished] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)
  // The go back the user started from this page; its steps show here.
  const [run, setRun] = useState<UpdateRunState | null>(null)
  // The highest store version any health read on this page asked for: going back is not offered past the one the previous version knows.
  const [schemaSeen, setSchemaSeen] = useState<number | null>(null)
  // Whether a poll showed the server going away: only after that is a plugin that does not come up a new version that failed to start.
  const [restartSeen, setRestartSeen] = useState(false)
  // The setup call outlives this screen; only a mounted screen draws what it reports.
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  // Polls while this screen is in view and something is left to wait for; the check stops by itself once the server refuses the session.
  const check = useServerCheck(connection, build, { poll: focused && !finished })
  const data = check.data
  // A 401 wins over the old data the query still holds, or the page would keep asking for a restart that already happened.
  const signedOut = isSignedOut(check.error)

  const seen = highestSchema(schemaSeen, data ?? null)
  if (seen !== schemaSeen) {
    setSchemaSeen(seen)
  }
  const sawRestart = restartSeenAfter(restartSeen, data ?? null, signedOut)
  if (sawRestart !== restartSeen) {
    setRestartSeen(sawRestart)
  }
  const update = useMemo<FinishUpdate>(
    () => finishUpdateOf({ started: connection.pluginUpdate, schemaSeen: seen, run, ended, restartSeen: sawRestart }),
    [connection.pluginUpdate, seen, run, ended, sawRestart]
  )
  const goingBack = runIsGoing(run)

  // The variant follows the server, except when a check names none (ready, or one poll that could not reach it): the page then stays as it was.
  const live = useMemo(() => finishVariant(data ?? null, manual, update), [data, manual, update])
  const [held, setHeld] = useState<FinishVariant | null>(live)
  if (live !== null && live !== held) {
    setHeld(live)
  }
  const variant = live ?? held
  const updateOpen = updateStillOpen(variant, data ?? null)

  // Once the plugin answers its setup runs. Record that as soon as the server said it is missing, off or outdated, so a closed app or a restart in between does not skip it. Not while the go back runs: it records the commit it installs itself.
  const commit = pendingCommit(data ?? null, build)
  useEffect(() => {
    if (commit !== null && !goingBack) {
      markPendingSetup(connection.id, commit)
    }
  }, [commit, goingBack, connection.id])

  // Each ready poll tries again until the setup went through: `dataUpdatedAt` moves with every poll, while the data stays the same object. A go back that runs does its own setup, and an update the user has yet to do is not finished by a ready answer.
  useEffect(() => {
    if (data?.kind !== 'ready' || finished || signedOut || goingBack || updateOpen) {
      return
    }
    finishPendingSetup(gateway, connection, data).then(
      () => {
        // Home and the other screens read the same check: make them see the finished setup.
        void queryClient.invalidateQueries({ queryKey: serverCheckKey(connection.id) })
        if (mounted.current) {
          setProblem(null)
          setFinished(true)
        }
      },
      (error: unknown) => {
        if (isSignedOut(error)) {
          // The session ended while the setup ran: the check says so too, and shows Sign in again.
          void queryClient.invalidateQueries({ queryKey: serverCheckKey(connection.id) })
        }
        if (mounted.current) {
          setProblem(setupProblem(error))
        }
      }
    )
  }, [data, check.dataUpdatedAt, finished, signedOut, goingBack, updateOpen, gateway, connection, queryClient])

  const setup: SetupProgress = finished ? { state: 'done' } : problem === null ? { state: 'pending' } : { state: 'failed', message: problem }
  const view = finishView(variant, build, signedOut ? 'sign_in' : (data ?? null), setup, run)

  const goBack = async () => {
    const started = connection.pluginUpdate
    if (started === undefined || build === null) {
      return
    }
    setRun(PENDING_UPDATE_RUN)
    const outcome = await runUpdate({ port: gateway, build, connectionId: connection.id, ...goBackTarget(started) }, (step, status) => {
      if (mounted.current) {
        setRun(current => (current ? { ...current, steps: { ...current.steps, [step]: status } } : current))
      }
    })
    // Home and the other screens read the same check; after a refused session this makes the page ask to sign in.
    await queryClient.invalidateQueries({ queryKey: serverCheckKey(connection.id) })
    if (!mounted.current) {
      return
    }
    if (outcome.kind === 'done') {
      // The run did the plugin's setup itself.
      setProblem(null)
      setFinished(true)
    }
    setRun(current => ({ steps: current?.steps ?? PENDING_UPDATE_RUN.steps, outcome }))
  }

  const recheck = async () => {
    setChecking(true)
    await check.refetch()
    if (mounted.current) {
      setChecking(false)
    }
  }

  const act = (action: FinishAction) => {
    switch (action) {
      case 'check':
        void recheck()
        return
      case 'done':
        // Home is under this screen when it was pushed from there, and not when Sign in replaced into it.
        router.dismissTo('/')
        return
      case 'sign_in':
        router.push({ pathname: '/sign-in', params: { connection: connection.id } })
        return
      case 'go_back':
        void goBack()
        return
    }
  }

  const openGuide = () => {
    Linking.openURL(view.guide.url).catch(() => Alert.alert('Could not open the guide', view.guide.url))
  }

  const { command, primary } = view
  return (
    <Page
      title={view.title}
      onBack={() => (router.canGoBack() ? router.back() : router.replace('/'))}
      footer={primary ? <Button label={primary.label} onPress={() => act(primary.action)} loading={primary.action === 'check' && checking} /> : undefined}
    >
      {view.intro.length > 0 ? (
        <View style={styles.text}>
          {view.intro.map(paragraph => (
            <Text key={paragraph} style={[styles.paragraph, { color: theme.colors.foreground }]}>
              {paragraph}
            </Text>
          ))}
        </View>
      ) : null}
      {command ? (
        <View style={styles.text}>
          <View style={[styles.command, { backgroundColor: theme.colors.muted }]}>
            <Text selectable style={[styles.commandText, { color: theme.colors.foreground }]}>
              {command}
            </Text>
          </View>
          <Button label="Copy" variant="secondary" onPress={() => void Clipboard.setStringAsync(command)} />
        </View>
      ) : null}
      {view.restartLines ? (
        <View style={styles.text}>
          <Text style={[styles.heading, { color: theme.colors.foreground }]}>{RESTART_HEADING}</Text>
          {view.restartLines.map(line => (
            <Text key={line} selectable style={[styles.line, { color: theme.colors.foreground }]}>
              {line}
            </Text>
          ))}
        </View>
      ) : null}
      {view.steps ? <StepList steps={view.steps} /> : null}
      <Text accessibilityLiveRegion="polite" style={view.done ? [styles.ready, { color: theme.colors.foreground }] : [styles.status, { color: theme.colors.mutedForeground }]}>
        {view.status}
      </Text>
      {view.done ? null : <Button label={view.guide.label} variant="secondary" onPress={openGuide} />}
    </Page>
  )
}

const styles = StyleSheet.create({
  text: { gap: SPACE.medium },
  paragraph: { ...TYPE.body, lineHeight: LEADING.body },
  command: { padding: SPACE.medium, borderRadius: RADIUS.medium },
  commandText: { ...TYPE.callout, fontFamily: MONOSPACE, lineHeight: LEADING.callout },
  heading: { ...TYPE.bodyStrong, lineHeight: LEADING.body },
  line: { ...TYPE.callout, lineHeight: LEADING.callout },
  status: { ...TYPE.callout, lineHeight: LEADING.callout },
  ready: { ...TYPE.bodyStrong, lineHeight: LEADING.body }
})
